// index.js

import { PublicKey, Transaction, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Client } from "@nosana/sdk";
const { BN } = anchor.default ?? anchor;
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";
import { Parser } from "json2csv";
import fs from "fs";
import path from "path";
import PQueue from "p-queue";
import * as state from "./state.js";
import http from "http";
import { WebSocketServer } from "ws";
import axios from "axios";
import { parse as csvParse } from "csv-parse/sync";

dotenv.config();

// ---------------------------
// Effect AI server-side config
// ---------------------------
const EFFECT_AUTH_KEY             = process.env.EFFECT_AUTH_KEY;
const EFFECT_PHASE1_DATASET_ID    = process.env.EFFECT_PHASE1_DATASET_ID;
const EFFECT_PHASE1_FETCHER_INDEX = process.env.EFFECT_PHASE1_FETCHER_INDEX !== undefined
  ? parseInt(process.env.EFFECT_PHASE1_FETCHER_INDEX, 10) : null;
const EFFECT_PHASE2_DATASET_ID    = process.env.EFFECT_PHASE2_DATASET_ID;
const EFFECT_PHASE2_FETCHER_INDEX = process.env.EFFECT_PHASE2_FETCHER_INDEX !== undefined
  ? parseInt(process.env.EFFECT_PHASE2_FETCHER_INDEX, 10) : null;

// Authenticate with the Effect AI task-poster; returns the session cookie or null
async function getEffectCookie() {
  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl || !EFFECT_AUTH_KEY) return null;
  try {
    const authRes = await axios.post(
      `${effectUrl}/auth`,
      new URLSearchParams({ key: EFFECT_AUTH_KEY }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 5, validateStatus: s => s < 500 }
    );
    const setCookie = authRes.headers["set-cookie"];
    return setCookie?.length ? setCookie[0].split(";")[0] : null;
  } catch { return null; }
}

const app = express();
app.use(express.json());
app.use(cors());

// ---------------------------
// Initialize KV
// ---------------------------

await state.db.open("data/kv-ledger");

async function kvGetSong(jobID) {
  const record = await state.db.get(["songs", jobID]);
  return record?.data ?? null;
}

async function kvListAllSongs() {
  return await state.db.listAll(["songs", {}]);
}

// ---------------------------
// Nosana + queue setup
// ---------------------------

const private_key = process.env.SOLANA_KEY;
const nosana = new Client("mainnet", private_key);

// Strict serialization + realistic pacing
const queue = new PQueue({
  concurrency: 1,
  interval: 20000,
  intervalCap: 1,
});

(async () => {
  try {
    const solBalanceRaw = await nosana.solana.getSolBalance(); // lamports
    const nosBalanceRaw = (await nosana.solana.getNosBalance())?.amount; // smallest units

    const solBalance = solBalanceRaw / 1000000000;
    const nosBalance = nosBalanceRaw / 1000000;

    console.log(`
      Connected wallet: ${nosana.solana.wallet.publicKey.toString()}
      SOL balance: ${solBalance} SOL
      NOS balance: ${nosBalance} NOS
    `);
  } catch (err) {
    console.warn("Warning: could not fetch nosana/solana balances:", err?.message || err);
  }
})();

// ---------------------------
// Routes
// ---------------------------

app.get("/", (req, res) => {
  res.sendStatus(200);
});

// GET /wallet/:pubkey/balances — SOL + NOS balance for any wallet
app.get("/wallet/:pubkey/balances", async (req, res) => {
  let pubkey;
  try {
    pubkey = new PublicKey(req.params.pubkey);
  } catch {
    return res.status(400).json({ error: "Invalid public key" });
  }

  try {
    const [solLamports, nosRaw] = await Promise.all([
      nosana.solana.getSolBalance(pubkey),
      nosana.solana.getNosBalance(pubkey),
    ]);
    res.json({
      sol: solLamports / 1e9,
      nos: nosRaw ? Number(nosRaw.amount) / 1e6 : 0,
    });
  } catch (err) {
    console.error("Balance fetch error:", err);
    res.status(500).json({ error: "Failed to fetch balances" });
  }
});

// POST /songurl
app.post("/songurl", async (req, res) => {
  const { selectedSongID, songTitle, artistName } = req.body;
  if (!selectedSongID) return res.status(400).json({ error: "selectedSongID required" });

  try {
    // Fetch balances on every submission
    const solBalanceRaw = await nosana.solana.getSolBalance();
    const nosBalanceRaw = (await nosana.solana.getNosBalance())?.amount;
    const solBalance = solBalanceRaw / 1000000000;
    const nosBalance = nosBalanceRaw / 1000000;

    const minSol = 0.02; // adjust minimum required SOL
    const minNos = 5;    // adjust minimum required NOS

    if (solBalance < minSol) {
      console.warn(`SOL balance too low (${solBalance} SOL). Rejecting submission.`);
      return res.status(400).json({ error: `Insufficient SOL (${solBalance} SOL)` });
    }

    if (nosBalance < minNos) {
      console.warn(`NOS balance too low (${nosBalance} NOS). Rejecting submission.`);
      return res.status(400).json({ error: `Insufficient NOS (${nosBalance} NOS)` });
    }

    const result = await queue.add(async () => {
      const songUrl = `https://api.audius.co/v1/tracks/${selectedSongID}/stream`;
      const jobID = uuidv4();

      // same json_flow as before
      const json_flow = {
        version: "0.1",
        type: "container",
        meta: { trigger: "cli" },
        ops: [
          {
            type: "container/run",
            id: "demucs-whisper",
            args: {
              cmd: [
                "--url", songUrl,
                "--output_dir", "/data/output",
                "--jobID", jobID,
              ],
              image: "docker.io/miggysmallz/nosana-song-to-lyric:v1.0.1",
              gpu: true,
            },
          },
        ],
      };

      const ipfsHash = await nosana.ipfs.pin(json_flow);
      console.log(`IPFS uploaded: ${nosana.ipfs.config.gateway}${ipfsHash}`);

      const market = new PublicKey(process.env.MARKET);
      console.log("Submitting job to Nosana...");
      let response;

      try {
        response = await nosana.jobs.list(ipfsHash, 3600, market);
      } catch (err) {
        console.error("Nosana jobs.list failed:", {
          message: err?.message,
          logs: err?.transactionLogs,
          tx: err?.transactionMessage,
          full: err,
        });
        throw err;
      }

      console.log("Nosana job listing response:", response);

      if (!response?.job) throw new Error("Nosana job listing returned no job id");

      console.log(`
        Posted to market: https://dashboard.nosana.com/markets/${market.toBase58()}
        Nosana Explorer: https://dashboard.nosana.com/jobs/${response.job}
      `);

      // Generate jobID only after successful listing

      const placeholder = {
        jobID,
        songUrl,
        songTitle: songTitle || "",
        artistName: artistName || "",
        lyrics: "",
        createdAt: new Date().toISOString(),
        status: "processing",
        nosanaJob: response.job,
      };

      await state.db.set(["songs", jobID], placeholder);

      // Cooldown for on-chain finalization
      await new Promise(resolve => setTimeout(resolve, 15000));

      return { jobID, songUrl };
    });

    res.json(result);
  } catch (err) {
    console.error("Error submitting job:", err);
    res.status(500).json({ error: "Failed to submit job" });
  }
});

// POST /buildJobTx — build a Nosana job tx for the user's wallet to sign & broadcast
app.post("/buildJobTx", async (req, res) => {
  const { userPublicKey, selectedSongID, songTitle, artistName } = req.body;
  if (!userPublicKey || !selectedSongID) {
    return res.status(400).json({ error: "userPublicKey and selectedSongID required" });
  }

  let userPubkey;
  try {
    userPubkey = new PublicKey(userPublicKey);
  } catch {
    return res.status(400).json({ error: "Invalid userPublicKey" });
  }

  try {
    const songUrl = `https://api.audius.co/v1/tracks/${selectedSongID}/stream`;
    const jobID = uuidv4();

    const json_flow = {
      version: "0.1",
      type: "container",
      meta: { trigger: "cli" },
      ops: [{
        type: "container/run",
        id: "demucs-whisper",
        args: {
          cmd: ["--url", songUrl, "--output_dir", "/data/output", "--jobID", jobID],
          image: "docker.io/miggysmallz/nosana-song-to-lyric:v1.0.1",
          gpu: true,
        },
      }],
    };

    const ipfsHash = await nosana.ipfs.pin(json_flow);
    console.log(`IPFS uploaded: ${nosana.ipfs.config.gateway}${ipfsHash}`);

    // Load SDK internals (cached after first call)
    await nosana.jobs.loadNosanaJobs();
    await nosana.jobs.setAccounts();

    const mint = new PublicKey(nosana.jobs.config.nos_address);
    const market = new PublicKey(process.env.MARKET);

    // Generate ephemeral keypairs the Nosana program requires
    const jobKey = Keypair.generate();
    const runKey = Keypair.generate();

    // Build accounts with user as payer + authority (user owns their job)
    const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
    const accounts = {
      ...nosana.jobs.accounts,
      job: jobKey.publicKey,
      run: runKey.publicKey,
      user: await getAssociatedTokenAddress(mint, userPubkey),
      payer: userPubkey,
      market,
      authority: userPubkey,
      vault: pda([market.toBuffer(), mint.toBuffer()], nosana.jobs.jobs.programId),
    };

    // Build the Anchor instruction without signing
    const { bs58: anchorBs58 } = await import("@coral-xyz/anchor/dist/cjs/utils/bytes/index.js");
    const ix = await nosana.jobs.jobs.methods
      .list([...anchorBs58.decode(ipfsHash).subarray(2)], new BN(3600))
      .accounts(accounts)
      .instruction();

    // Wrap in a legacy Transaction
    const { blockhash, lastValidBlockHeight } = await nosana.jobs.connection.getLatestBlockhash();
    const tx = new Transaction();
    tx.feePayer = userPubkey;
    tx.recentBlockhash = blockhash;
    tx.add(ix);

    // Partially sign with the ephemeral keypairs
    tx.partialSign(jobKey, runKey);

    const base64tx = tx.serialize({ requireAllSignatures: false }).toString("base64");

    // Persist as pending until user confirms
    await state.db.set(["songs", jobID], {
      jobID,
      songUrl,
      songTitle: songTitle || "",
      artistName: artistName || "",
      lyrics: "",
      createdAt: new Date().toISOString(),
      status: "pending_signature",
      nosanaJob: jobKey.publicKey.toBase58(),
    });

    res.json({ base64tx, jobID, nosanaJob: jobKey.publicKey.toBase58(), lastValidBlockHeight });
  } catch (err) {
    console.error("Error building job tx:", err);
    res.status(500).json({ error: "Failed to build job transaction" });
  }
});

// POST /registerJob — called by frontend after user signs & broadcasts
app.post("/registerJob", async (req, res) => {
  const { jobID, txSignature } = req.body;
  if (!jobID) return res.status(400).json({ error: "jobID required" });

  const record = await kvGetSong(jobID);
  if (!record) return res.status(404).json({ error: "Job not found" });

  await state.db.set(["songs", jobID], {
    ...record,
    status: "processing",
    txSignature: txSignature || null,
  });

  console.log(`Job ${jobID} registered as processing (tx: ${txSignature})`);
  res.json({ status: "ok" });
});

// POST /addSong
app.post("/addSong", async (req, res) => {
  const { jobID, songUrl, lyrics } = req.body;
  if (!jobID || !songUrl) {
    return res.status(400).json({ error: "jobID and songUrl required" });
  }

  const song = {
    jobID,
    songUrl,
    lyrics: lyrics || "",
    createdAt: new Date().toISOString(),
    status: "ready",
  };

  await state.db.set(["songs", jobID], song);
  console.log(`Saved song into KV: ${jobID}`);

  broadcastUpdate(jobID, {
    type: "lyrics_ready",
    data: song,
  });

  // Fire-and-forget: auto-post this song's segments to Effect AI Phase 1
  autoPostSongToEffect(song).catch(e => console.warn("autoPostSongToEffect:", e?.message));

  res.json({ status: "ok" });
});

// POST /checkJob
app.post("/checkJob", async (req, res) => {
  const { jobID } = req.body;
  if (!jobID) return res.status(400).json({ error: "jobID required" });

  const record = await kvGetSong(jobID);
  if (!record) return res.json({ status: 204 });

  if (record.lyrics) {
    return res.json({
      status: 200,
      lyrics: record.lyrics,
      validatedLyrics: record.validatedLyrics || null,
    });
  }

  // Already confirmed failed on a previous check
  if (record.status === "failed") {
    return res.json({ status: 204, failed: true });
  }

  // For jobs pending > 5 min with a Nosana job address, read the on-chain job
  // state via the SDK. Only mark as failed if the job is STOPPED or the account
  // doesn't exist at all (tx never confirmed).
  if (record.nosanaJob && !record.nosanaJobChecked && record.createdAt) {
    const ageMs = Date.now() - new Date(record.createdAt).getTime();
    if (ageMs > 5 * 60 * 1000) {
      try {
        const jobData = await nosana.jobs.get(record.nosanaJob);
        if (jobData?.state === "STOPPED") {
          console.log(`checkJob: Nosana job STOPPED for ${jobID} — marking failed`);
          await state.db.set(["songs", jobID], { ...record, status: "failed", nosanaJobChecked: true });
          return res.json({ status: 204, failed: true });
        }
        if (jobData?.state === "COMPLETED" && jobData?.ipfsResult) {
          // Fetch the IPFS result and check whether the container actually succeeded
          try {
            const ipfsUrl = `${nosana.ipfs.config.gateway}${jobData.ipfsResult}`;
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 8000);
            const ipfsRes = await fetch(ipfsUrl, { signal: controller.signal });
            clearTimeout(t);
            const result = await ipfsRes.json();
            const containerFailed = result?.opStates?.some(op => op.exitCode !== 0);
            if (containerFailed) {
              console.log(`checkJob: Nosana job COMPLETED but container exited non-zero for ${jobID} — marking failed`);
              await state.db.set(["songs", jobID], { ...record, status: "failed", nosanaJobChecked: true });
              return res.json({ status: 204, failed: true });
            }
          } catch (ipfsErr) {
            console.warn(`checkJob: could not read IPFS result for ${jobID}:`, ipfsErr?.message);
          }
        }
        // Job is QUEUED / RUNNING / or COMPLETED with exit 0 — stop re-checking every poll
        await state.db.set(["songs", jobID], { ...record, nosanaJobChecked: true });
      } catch (err) {
        // Anchor throws when the account doesn't exist (tx never landed on-chain)
        const msg = err?.message ?? "";
        if (msg.includes("Account does not exist") || msg.includes("could not find account")) {
          console.log(`checkJob: Nosana job account missing for ${jobID} — marking failed`);
          await state.db.set(["songs", jobID], { ...record, status: "failed", nosanaJobChecked: true });
          return res.json({ status: 204, failed: true });
        }
        // RPC or other transient error — skip, retry next poll
        console.warn(`checkJob: could not read Nosana job for ${jobID}:`, msg);
      }
    }
  }

  return res.json({ status: 204 });
});

// Shared SRT helpers
function timeStrToSeconds(timeStr) {
  const [hms, ms] = timeStr.split(",");
  const [hh, mm, ss] = hms.split(":").map(Number);
  return hh * 3600 + mm * 60 + ss + parseInt(ms, 10) / 1000;
}

function parseSRTtoRows(srtText, jobID, songUrl, songTitle = "", artistName = "", nosanaJob = "") {
  if (!srtText) return [];
  srtText = srtText.replace(/\\n/g, "\n");
  const blocks = srtText.split(/\n\s*\n/).filter(Boolean);
  return blocks.flatMap(block => {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length < 2 || !lines[1].includes("-->")) return [];
    const [startStr, endStr] = lines[1].split("-->").map(s => s.trim());
    return [{
      jobID,
      title: songTitle,
      artist: artistName,
      song_url: songUrl,
      nosana_job: nosanaJob,
      start: timeStrToSeconds(startStr),
      end: timeStrToSeconds(endStr),
      lyrics: lines.slice(2).join(" ").trim(),
    }];
  });
}

// ---------------------------
// Effect AI helpers
// ---------------------------

// Convert a segments array [{start,end,lyrics}] back to SRT format
function segmentsToSRT(segments) {
  const toSRTTime = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s % 1) * 1000);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")},${String(ms).padStart(3,"0")}`;
  };
  return segments.map((seg, i) =>
    `${i + 1}\n${toSRTTime(seg.start)} --> ${toSRTTime(seg.end)}\n${seg.lyrics}`
  ).join("\n\n");
}

// Post a single song's SRT segments to the Phase 1 Effect AI fetcher (called after /addSong)
async function autoPostSongToEffect(song) {
  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl || !EFFECT_AUTH_KEY || !EFFECT_PHASE1_DATASET_ID || EFFECT_PHASE1_FETCHER_INDEX === null) return;
  const rows = parseSRTtoRows(song.lyrics, song.jobID, song.songUrl, song.songTitle, song.artistName, song.nosanaJob);
  if (!rows.length) return;
  try {
    const parser = new Parser({ fields: ["jobID", "title", "artist", "song_url", "nosana_job", "start", "end", "lyrics"] });
    const csv = parser.parse(rows);
    const cookie = await getEffectCookie();
    if (!cookie) { console.warn("autoPostSongToEffect: could not get Effect AI cookie"); return; }
    await axios.post(
      `${effectUrl}/d/${EFFECT_PHASE1_DATASET_ID}/f/${EFFECT_PHASE1_FETCHER_INDEX}/import`,
      new URLSearchParams({ csv, delimiter: "," }).toString(),
      { headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } }
    );
    await state.db.set(["songs", song.jobID], { ...song, effectPhase1Posted: true });
    console.log(`Auto-posted ${rows.length} segments for job ${song.jobID} to Effect AI Phase 1`);
  } catch (err) {
    console.warn("autoPostSongToEffect failed:", err?.message);
  }
}

// Background scan: update per-song Phase 1 validated counts and apply Phase 2 validated lyrics
async function scanEffectResults() {
  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl || !EFFECT_AUTH_KEY) return;

  try {
    const cookie = await getEffectCookie();
    if (!cookie) return;

    // --- Phase 1 scan: count unique validated segments per jobID ---
    if (EFFECT_PHASE1_DATASET_ID && EFFECT_PHASE1_FETCHER_INDEX !== null) {
      try {
        const p1Res = await axios.get(
          `${effectUrl}/d/${EFFECT_PHASE1_DATASET_ID}/f/${EFFECT_PHASE1_FETCHER_INDEX}/download`,
          { headers: { Cookie: cookie }, responseType: "text", validateStatus: s => s < 500 }
        );
        if (p1Res.data?.trim()) {
          const rows = csvParse(p1Res.data, { columns: true, skip_empty_lines: true, trim: true });

          // Build count set AND full segment data per song (needed for Phase 2 auto-post)
          const counts   = new Map(); // jobID -> Set of "start-end" keys
          const songData = new Map(); // jobID -> { song_url, segments: Map<"start-end", {start,end,lyrics}> }

          for (const row of rows) {
            try {
              const answer = JSON.parse(row.result)?.values?.answer;
              if (!answer?.jobID || answer.allowedStart === undefined) continue;
              const segKey = `${answer.allowedStart}-${answer.allowedEnd}`;

              if (!counts.has(answer.jobID)) counts.set(answer.jobID, new Set());
              counts.get(answer.jobID).add(segKey);

              if (!songData.has(answer.jobID)) {
                songData.set(answer.jobID, { song_url: answer.song, segments: new Map() });
              }
              // Keep last submission per segment (Map overwrites on duplicate key)
              songData.get(answer.jobID).segments.set(segKey, {
                start:  answer.allowedStart,
                end:    answer.allowedEnd,
                lyrics: answer.verifiedLyrics,
              });
            } catch (e) {
              console.warn("Effect Phase 1 scan: row parse error:", e?.message);
            }
          }

          // Update KV with Phase 1 counts
          for (const [jobID, segSet] of counts) {
            const existing = (await state.db.get(["effect_status", jobID]))?.data ?? {};
            await state.db.set(["effect_status", jobID], {
              ...existing,
              phase1ValidatedSegments: segSet.size,
              phase1LastScan: new Date().toISOString(),
            });
          }
          console.log(`Effect scan: Phase 1 updated ${counts.size} songs`);

          // Auto-post Phase 2 for songs where all segments are now validated
          if (EFFECT_PHASE2_DATASET_ID && EFFECT_PHASE2_FETCHER_INDEX !== null) {
            const phase2ReadyRows = [];
            for (const [jobID, data] of songData) {
              try {
                const song = await kvGetSong(jobID);
                if (!song?.lyrics) continue;
                const totalSegs = parseSRTtoRows(song.lyrics, jobID, song.songUrl).length;
                if (totalSegs === 0 || data.segments.size < totalSegs) continue;

                const effectStatus = (await state.db.get(["effect_status", jobID]))?.data ?? {};
                if (effectStatus.phase2Posted) continue; // already posted

                const segments = Array.from(data.segments.values()).sort((a, b) => a.start - b.start);
                phase2ReadyRows.push({ song_url: data.song_url, jobID, segments });

                // Mark as posted before attempting (will revert on failure)
                await state.db.set(["effect_status", jobID], {
                  ...effectStatus,
                  phase1ValidatedSegments: data.segments.size,
                  phase1LastScan: new Date().toISOString(),
                  phase2Posted: true,
                  phase2PostedAt: new Date().toISOString(),
                });
                console.log(`Effect scan: queued auto Phase 2 for ${jobID} (${data.segments.size}/${totalSegs} segments validated)`);
              } catch (e) {
                console.warn(`Effect scan: Phase 2 auto-post check error for ${jobID}:`, e?.message);
              }
            }

            if (phase2ReadyRows.length) {
              try {
                const csvLines = ["song_url,jobID,segments"];
                for (const s of phase2ReadyRows) {
                  const segmentsJson = JSON.stringify(s.segments);
                  const escaped = '"' + segmentsJson.replace(/"/g, '""') + '"';
                  csvLines.push(`${s.song_url},${s.jobID},${escaped}`);
                }
                await axios.post(
                  `${effectUrl}/d/${EFFECT_PHASE2_DATASET_ID}/f/${EFFECT_PHASE2_FETCHER_INDEX}/import`,
                  new URLSearchParams({ csv: csvLines.join("\n"), delimiter: "," }).toString(),
                  { headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } }
                );
                console.log(`Effect scan: auto-posted Phase 2 for ${phase2ReadyRows.length} song(s)`);
              } catch (e) {
                console.warn("Effect auto-post Phase 2 error:", e?.message);
                // Revert phase2Posted so the next scan retries
                for (const row of phase2ReadyRows) {
                  try {
                    const existing = (await state.db.get(["effect_status", row.jobID]))?.data ?? {};
                    await state.db.set(["effect_status", row.jobID], { ...existing, phase2Posted: false });
                  } catch {}
                }
              }
            }
          }
        }
      } catch (e) { console.warn("Effect Phase 1 scan error:", e?.message); }
    }

    // --- Phase 2 scan: apply validated full-song lyrics ---
    if (EFFECT_PHASE2_DATASET_ID && EFFECT_PHASE2_FETCHER_INDEX !== null) {
      try {
        const p2Res = await axios.get(
          `${effectUrl}/d/${EFFECT_PHASE2_DATASET_ID}/f/${EFFECT_PHASE2_FETCHER_INDEX}/download`,
          { headers: { Cookie: cookie }, responseType: "text", validateStatus: s => s < 500 }
        );
        if (!p2Res.data?.trim()) {
          console.log("Effect Phase 2 scan: download returned empty");
        } else {
          const rows = csvParse(p2Res.data, { columns: true, skip_empty_lines: true, trim: true });
          console.log(`Effect Phase 2 scan: ${rows.length} row(s) found`);
          for (const row of rows) {
            try {
              const payload = JSON.parse(row.result);
              const answer = payload?.values?.answer;
              if (!answer?.jobID) {
                console.log("Effect Phase 2 scan: row skipped — no jobID. Answer keys:", Object.keys(answer ?? {}));
                continue;
              }
              // Accept verifiedLyrics, verifiedSegments, or segments as the validated array field
              const segs = answer.verifiedLyrics ?? answer.verifiedSegments ?? answer.segments;
              if (!Array.isArray(segs) || !segs.length) {
                console.log(`Effect Phase 2 scan: ${answer.jobID} skipped — no segments array. Answer keys: [${Object.keys(answer).join(", ")}]`);
                continue;
              }

              const song = await kvGetSong(answer.jobID);
              if (!song) {
                console.log(`Effect Phase 2 scan: ${answer.jobID} not found in KV — skipping`);
                continue;
              }
              if (song.validatedLyrics) {
                console.log(`Effect Phase 2 scan: ${answer.jobID} already has validatedLyrics — skipping`);
                continue;
              }

              const validatedSRT = segmentsToSRT(segs);
              const updated = { ...song, lyrics: validatedSRT, validatedLyrics: segs };
              await state.db.set(["songs", answer.jobID], updated);

              // Mark Phase 2 complete in effect_status
              const existing = (await state.db.get(["effect_status", answer.jobID]))?.data ?? {};
              await state.db.set(["effect_status", answer.jobID], {
                ...existing, phase2Completed: true, phase2CompletedAt: new Date().toISOString(),
              });

              broadcastUpdate(answer.jobID, { type: "lyrics_ready", data: updated });
              console.log(`Effect scan: applied Phase 2 validated lyrics for ${answer.jobID}`);
            } catch (e) {
              console.warn("Effect Phase 2 scan: row processing error:", e?.message, "| raw result preview:", String(row.result ?? "").slice(0, 200));
            }
          }
        }
      } catch (e) { console.warn("Effect Phase 2 scan error:", e?.message); }
    }
  } catch (err) {
    console.warn("scanEffectResults error:", err?.message);
  }
}

// GET /effectStatus/:jobID — per-song Effect AI validation status
app.get("/effectStatus/:jobID", async (req, res) => {
  const { jobID } = req.params;
  const song = await kvGetSong(jobID);
  if (!song) return res.status(404).json({ error: "Job not found" });

  const totalSegments = parseSRTtoRows(song.lyrics || "", jobID, song.songUrl).length;
  const effectStatus  = (await state.db.get(["effect_status", jobID]))?.data ?? {};

  res.json({
    jobID,
    effectPhase1Posted: song.effectPhase1Posted ?? false,
    phase1: {
      total:     totalSegments,
      validated: effectStatus.phase1ValidatedSegments ?? 0,
      lastScan:  effectStatus.phase1LastScan ?? null,
    },
    phase2: {
      posted:      effectStatus.phase2Posted ?? false,
      postedAt:    effectStatus.phase2PostedAt ?? null,
      completed:   effectStatus.phase2Completed ?? false,
      completedAt: effectStatus.phase2CompletedAt ?? null,
    },
  });
});

// GET /downloadCSV — one row per lyric segment
app.get("/downloadCSV", async (req, res) => {
  try {
    const allSongs = await kvListAllSongs();
    if (!allSongs.length) return res.json({ status: 204, songs: [] });

    const csvRows = allSongs.flatMap(song =>
      parseSRTtoRows(song.data?.lyrics, song.data?.jobID, song.data?.songUrl)
    );

    const parser = new Parser({ fields: ["jobID", "song_url", "start", "end", "lyrics"] });
    const csv = parser.parse(csvRows);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=songs.csv");
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch songs" });
  }
});

// GET /exportForEffect — one row per SRT segment, ready to submit to Effect AI
app.get("/exportForEffect", async (req, res) => {
  try {
    const allSongs = await kvListAllSongs();
    const readySongs = allSongs
      .map(s => s.data)
      .filter(d => d?.status === "ready" && d?.lyrics);

    if (!readySongs.length) return res.json({ status: 204, songs: [] });

    const rows = readySongs.flatMap(song =>
      parseSRTtoRows(song.lyrics, song.jobID, song.songUrl, song.songTitle, song.artistName, song.nosanaJob)
    );

    const parser = new Parser({ fields: ["jobID", "title", "artist", "song_url", "nosana_job", "start", "end", "lyrics"] });
    const csv = parser.parse(rows);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=songs_for_effect.csv");
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to export songs for Effect AI" });
  }
});

// POST /postToEffect — import ready lyrics into the Phase 1 Effect AI fetcher
app.post("/postToEffect", async (req, res) => {
  const { datasetId, fetcherIndex } = req.body;
  const _datasetId    = datasetId    ?? EFFECT_PHASE1_DATASET_ID;
  const _fetcherIndex = fetcherIndex ?? EFFECT_PHASE1_FETCHER_INDEX;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!_datasetId || _fetcherIndex === null) {
    return res.status(400).json({ error: "datasetId and fetcherIndex are required (or set EFFECT_PHASE1_DATASET_ID/EFFECT_PHASE1_FETCHER_INDEX env vars)" });
  }

  try {
    const allSongs = await kvListAllSongs();
    const readySongs = allSongs.map(s => s.data).filter(d => d?.status === "ready" && d?.lyrics);
    if (!readySongs.length) return res.status(400).json({ error: "No ready songs to export" });

    const rows = readySongs.flatMap(song =>
      parseSRTtoRows(song.lyrics, song.jobID, song.songUrl, song.songTitle, song.artistName, song.nosanaJob)
    );
    const parser = new Parser({ fields: ["jobID", "title", "artist", "song_url", "nosana_job", "start", "end", "lyrics"] });
    const csv = parser.parse(rows);

    const cookie = await getEffectCookie();
    if (!cookie) return res.status(401).json({ error: "Effect AI auth failed — check EFFECT_AUTH_KEY server env var" });

    await axios.post(
      `${effectUrl}/d/${_datasetId}/f/${_fetcherIndex}/import`,
      new URLSearchParams({ csv, delimiter: "," }).toString(),
      { headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } }
    );

    res.json({ status: "ok", datasetId: _datasetId, fetcherIndex: _fetcherIndex, taskCount: rows.length });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error("postToEffect error:", detail);
    res.status(500).json({ error: "Failed to post to Effect AI", detail: String(detail) });
  }
});

// POST /effectStats — fetch queue counts from an Effect AI fetcher
app.post("/effectStats", async (req, res) => {
  const { datasetId, fetcherIndex } = req.body;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!datasetId || fetcherIndex === undefined) {
    return res.status(400).json({ error: "datasetId and fetcherIndex are required" });
  }

  try {
    const cookie = await getEffectCookie();
    if (!cookie) return res.status(401).json({ error: "Effect AI auth failed — check EFFECT_AUTH_KEY server env var" });

    const statsRes = await axios.get(
      `${effectUrl}/d/${datasetId}/f/${fetcherIndex}`,
      { headers: { Cookie: cookie }, validateStatus: s => s < 500 }
    );

    // The endpoint returns HTML, not JSON. Parse counts from <li> tags.
    const html = String(statsRes.data ?? "");
    const extract = (label) => {
      const m = html.match(new RegExp(`<li>${label}:\\s*(\\d+)<\\/li>`));
      return m ? parseInt(m[1], 10) : null;
    };
    res.json({
      queue:  extract("Queued"),
      active: extract("Active"),
      done:   extract("Finished"),
      failed: extract("Failed"),
    });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error("effectStats error:", detail);
    res.status(500).json({ error: "Failed to fetch Effect AI stats", detail: String(detail) });
  }
});

// POST /debugPhase1Parse — download + parse Phase 1 results without posting to Phase 2 (for testing)
app.post("/debugPhase1Parse", async (req, res) => {
  const { phase1DatasetId, phase1FetcherIndex } = req.body;
  const _datasetId    = phase1DatasetId    ?? EFFECT_PHASE1_DATASET_ID;
  const _fetcherIndex = phase1FetcherIndex ?? EFFECT_PHASE1_FETCHER_INDEX;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!_datasetId || _fetcherIndex === null) {
    return res.status(400).json({ error: "phase1DatasetId and phase1FetcherIndex are required" });
  }

  try {
    const cookie = await getEffectCookie();
    if (!cookie) return res.status(401).json({ error: "Effect AI auth failed — check EFFECT_AUTH_KEY server env var" });

    const dlRes = await axios.get(
      `${effectUrl}/d/${_datasetId}/f/${_fetcherIndex}/download`,
      { headers: { Cookie: cookie }, responseType: "text", validateStatus: s => s < 500 }
    );

    const rawCsvPreview = dlRes.data?.slice(0, 1000) ?? "";
    let parsedRows = [], parseError = null;
    try {
      parsedRows = csvParse(dlRes.data, { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) {
      parseError = e.message;
    }

    const firstRow = parsedRows[0] ?? null;
    let firstRowResult = null, firstRowPayload = null, firstRowError = null;
    if (firstRow) {
      firstRowResult = String(firstRow.result ?? "").slice(0, 500);
      try {
        const payload = JSON.parse(firstRow.result);
        const answer = payload?.values?.answer;
        firstRowPayload = {
          task: payload?.task,
          answerKeys: Object.keys(answer ?? {}),
          jobID: answer?.jobID,
          song: answer?.song,
          allowedStart: answer?.allowedStart,
          allowedEnd: answer?.allowedEnd,
          verifiedLyrics: answer?.verifiedLyrics,
          verifiedLyricsType: typeof answer?.verifiedLyrics,
        };
      } catch (e) {
        firstRowError = e.message;
      }
    }

    res.json({
      rawCsvPreview,
      parseError,
      rowCount: parsedRows.length,
      firstRowKeys: firstRow ? Object.keys(firstRow) : null,
      firstRowResultPreview: firstRowResult,
      firstRowPayload,
      firstRowError,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// POST /compileAndPostPhase2 — download Phase 1 results, compile per-song, import to Phase 2 fetcher
app.post("/compileAndPostPhase2", async (req, res) => {
  const { phase1DatasetId, phase1FetcherIndex, phase2DatasetId, phase2FetcherIndex } = req.body;
  const _p1DatasetId    = phase1DatasetId    ?? EFFECT_PHASE1_DATASET_ID;
  const _p1FetcherIndex = phase1FetcherIndex ?? EFFECT_PHASE1_FETCHER_INDEX;
  const _p2DatasetId    = phase2DatasetId    ?? EFFECT_PHASE2_DATASET_ID;
  const _p2FetcherIndex = phase2FetcherIndex ?? EFFECT_PHASE2_FETCHER_INDEX;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!_p1DatasetId || _p1FetcherIndex === null || !_p2DatasetId || _p2FetcherIndex === null) {
    return res.status(400).json({ error: "Phase 1 and Phase 2 datasetId/fetcherIndex are required (or set env vars)" });
  }

  try {
    // 1. Auth
    const cookie = await getEffectCookie();
    if (!cookie) return res.status(401).json({ error: "Effect AI auth failed — check EFFECT_AUTH_KEY server env var" });

    // 2. Download Phase 1 results CSV
    const dlRes = await axios.get(
      `${effectUrl}/d/${_p1DatasetId}/f/${_p1FetcherIndex}/download`,
      { headers: { Cookie: cookie }, responseType: "text", validateStatus: s => s < 500 }
    );
    if (!dlRes.data || !dlRes.data.trim()) {
      return res.status(400).json({ error: "No Phase 1 results to compile" });
    }

    // 3. Parse CSV (result column contains embedded JSON)
    console.log("Phase 1 raw CSV (first 800 chars):", dlRes.data.slice(0, 800));
    const rows = csvParse(dlRes.data, { columns: true, skip_empty_lines: true, trim: true });
    console.log(`Phase 1 parsed ${rows.length} rows. First row keys:`, rows[0] ? Object.keys(rows[0]) : "none");
    if (rows[0]) {
      console.log("First row.result (first 300 chars):", String(rows[0].result ?? "").slice(0, 300));
    }

    // 4. Each Phase 1 row is one segment: answer has allowedStart, allowedEnd, verifiedLyrics (string).
    //    Group by jobID, collecting all segments. Deduplicate by start+end (keep last submission).
    const songMap = new Map();
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.result);
        const answer = payload?.values?.answer;
        if (!answer?.jobID || !answer?.song || answer.verifiedLyrics === undefined) continue;
        if (answer.allowedStart === undefined || answer.allowedEnd === undefined) continue;

        if (!songMap.has(answer.jobID)) {
          songMap.set(answer.jobID, { song_url: answer.song, jobID: answer.jobID, segments: new Map() });
        }
        const segKey = `${answer.allowedStart}-${answer.allowedEnd}`;
        songMap.get(answer.jobID).segments.set(segKey, {
          start: answer.allowedStart,
          end: answer.allowedEnd,
          lyrics: answer.verifiedLyrics,
        });
      } catch (e) { console.log("Row parse error:", e.message); }
    }

    if (!songMap.size) {
      return res.status(400).json({ error: "No valid Phase 1 song results found in download" });
    }

    // 5. Build Phase 2 CSV — one row per song with segments sorted by start time
    const songs = Array.from(songMap.values()).map(s => ({
      song_url: s.song_url,
      jobID: s.jobID,
      segments: Array.from(s.segments.values()).sort((a, b) => a.start - b.start),
    }));
    console.log(`Compiled ${songs.length} songs. First song: ${songs[0]?.jobID}, ${songs[0]?.segments.length} segments`);

    const csvLines = ["song_url,jobID,segments"];
    for (const s of songs) {
      const segmentsJson = JSON.stringify(s.segments);
      const escapedSegments = '"' + segmentsJson.replace(/"/g, '""') + '"';
      csvLines.push(`${s.song_url},${s.jobID},${escapedSegments}`);
    }
    const phase2Csv = csvLines.join("\n");
    console.log("Phase 2 CSV preview (first 500 chars):", phase2Csv.slice(0, 500));

    // 6. Import to Phase 2 fetcher
    await axios.post(
      `${effectUrl}/d/${_p2DatasetId}/f/${_p2FetcherIndex}/import`,
      new URLSearchParams({ csv: phase2Csv, delimiter: "," }).toString(),
      { headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } }
    );

    res.json({ status: "ok", taskCount: songs.length, phase2DatasetId: _p2DatasetId, phase2FetcherIndex: _p2FetcherIndex });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error("compileAndPostPhase2 error:", detail);
    res.status(500).json({ error: "Failed to compile and post Phase 2", detail: String(detail) });
  }
});

// POST /downloadPhase2 — proxy the task-poster's result download as a CSV file
app.post("/downloadPhase2", async (req, res) => {
  const { datasetId, fetcherIndex } = req.body;
  const _datasetId    = datasetId    ?? EFFECT_PHASE2_DATASET_ID;
  const _fetcherIndex = fetcherIndex ?? EFFECT_PHASE2_FETCHER_INDEX;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!_datasetId || _fetcherIndex === null) {
    return res.status(400).json({ error: "datasetId and fetcherIndex are required" });
  }

  try {
    const cookie = await getEffectCookie();
    if (!cookie) return res.status(401).json({ error: "Effect AI auth failed — check EFFECT_AUTH_KEY server env var" });

    const dlRes = await axios.get(
      `${effectUrl}/d/${_datasetId}/f/${_fetcherIndex}/download`,
      { headers: { Cookie: cookie }, responseType: "text", validateStatus: s => s < 500 }
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=phase2_results.csv");
    res.send(dlRes.data);
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error("downloadPhase2 error:", detail);
    res.status(500).json({ error: "Failed to download Phase 2 results", detail: String(detail) });
  }
});

// POST /triggerScan — manually run the background Effect AI scanner immediately
app.post("/triggerScan", async (_req, res) => {
  try {
    await scanEffectResults();
    res.json({ status: "ok", message: "Scan complete — check server logs for details" });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// POST /debugPhase2Parse — inspect Phase 2 result format without side effects
app.post("/debugPhase2Parse", async (req, res) => {
  const { phase2DatasetId, phase2FetcherIndex } = req.body;
  const _datasetId    = phase2DatasetId    ?? EFFECT_PHASE2_DATASET_ID;
  const _fetcherIndex = phase2FetcherIndex ?? EFFECT_PHASE2_FETCHER_INDEX;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!_datasetId || _fetcherIndex === null) {
    return res.status(400).json({ error: "phase2DatasetId and phase2FetcherIndex are required" });
  }

  try {
    const cookie = await getEffectCookie();
    if (!cookie) return res.status(401).json({ error: "Effect AI auth failed — check EFFECT_AUTH_KEY server env var" });

    const dlRes = await axios.get(
      `${effectUrl}/d/${_datasetId}/f/${_fetcherIndex}/download`,
      { headers: { Cookie: cookie }, responseType: "text", validateStatus: s => s < 500 }
    );

    const rawCsvPreview = dlRes.data?.slice(0, 1000) ?? "";
    let parsedRows = [], parseError = null;
    try {
      parsedRows = csvParse(dlRes.data, { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) { parseError = e.message; }

    const firstRow = parsedRows[0] ?? null;
    let firstRowPayload = null, firstRowError = null;
    if (firstRow) {
      try {
        const payload = JSON.parse(firstRow.result);
        const answer = payload?.values?.answer;
        const segs = answer?.verifiedLyrics ?? answer?.verifiedSegments ?? answer?.segments;
        firstRowPayload = {
          task: payload?.task,
          answerKeys: Object.keys(answer ?? {}),
          jobID: answer?.jobID,
          hasVerifiedSegments: Array.isArray(answer?.verifiedSegments),
          verifiedSegmentsLength: Array.isArray(answer?.verifiedSegments) ? answer.verifiedSegments.length : null,
          hasSegments: Array.isArray(answer?.segments),
          segmentsLength: Array.isArray(answer?.segments) ? answer.segments.length : null,
          firstSegment: Array.isArray(segs) ? segs[0] : null,
          willApply: Array.isArray(segs) && segs.length > 0,
        };
      } catch (e) { firstRowError = e.message; }
    }

    res.json({ rawCsvPreview, parseError, rowCount: parsedRows.length, firstRowPayload, firstRowError });
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ---------------------------
// Server + WebSocket
// ---------------------------

const port = process.env.PORT || 3001;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map();

function broadcastUpdate(jobID, message) {
  const subs = clients.get(jobID);
  if (!subs) return;
  const msg = JSON.stringify(message);
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(msg);
      } catch {}
    }
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const jobIDFromQuery = url.searchParams.get("jobID");

  ws._subscribedJobIDs = new Set();

  if (jobIDFromQuery) {
    if (!clients.has(jobIDFromQuery)) {
      clients.set(jobIDFromQuery, new Set());
    }
    clients.get(jobIDFromQuery).add(ws);
    ws._subscribedJobIDs.add(jobIDFromQuery);
  }

  ws.on("message", msg => {
    let parsed;
    try {
      parsed = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (parsed?.type === "subscribe" && parsed.jobID) {
      if (!clients.has(parsed.jobID)) {
        clients.set(parsed.jobID, new Set());
      }
      clients.get(parsed.jobID).add(ws);
      ws._subscribedJobIDs.add(parsed.jobID);
    }
  });

  ws.on("close", () => {
    for (const id of ws._subscribedJobIDs) {
      clients.get(id)?.delete(ws);
      if (clients.get(id)?.size === 0) {
        clients.delete(id);
      }
    }
    ws._subscribedJobIDs.clear();
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
  // Kick off Effect AI background scan every 1 minute
  if (process.env.EFFECT_URL && EFFECT_AUTH_KEY) {
    scanEffectResults(); // run once on startup
    setInterval(scanEffectResults, 1 * 60 * 1000);
    console.log("Effect AI background scanner started (1 min interval)");
  }
});
