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

  res.json({ status: "ok" });
});

// POST /checkJob
app.post("/checkJob", async (req, res) => {
  const { jobID } = req.body;
  if (!jobID) return res.status(400).json({ error: "jobID required" });

  const record = await kvGetSong(jobID);
  if (record && record.lyrics) {
    return res.json({ status: 200, lyrics: record.lyrics });
  } else {
    return res.json({ status: 204 });
  }
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

// POST /postToEffect — import ready lyrics into an existing Effect AI fetcher
app.post("/postToEffect", async (req, res) => {
  const { authKey, datasetId, fetcherIndex } = req.body;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!authKey || !datasetId || fetcherIndex === undefined) {
    return res.status(400).json({ error: "authKey, datasetId, and fetcherIndex are required" });
  }

  try {
    // 1. Build CSV (same logic as /exportForEffect)
    const allSongs = await kvListAllSongs();
    const readySongs = allSongs.map(s => s.data).filter(d => d?.status === "ready" && d?.lyrics);
    if (!readySongs.length) return res.status(400).json({ error: "No ready songs to export" });

    const rows = readySongs.flatMap(song =>
      parseSRTtoRows(song.lyrics, song.jobID, song.songUrl, song.songTitle, song.artistName, song.nosanaJob)
    );
    const parser = new Parser({ fields: ["jobID", "title", "artist", "song_url", "nosana_job", "start", "end", "lyrics"] });
    const csv = parser.parse(rows);

    // 2. Authenticate with task-poster (cookie session)
    const authRes = await axios.post(
      `${effectUrl}/auth`,
      new URLSearchParams({ key: authKey }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        maxRedirects: 5,
        validateStatus: s => s < 500,
      }
    );
    const setCookie = authRes.headers["set-cookie"];
    if (!setCookie || !setCookie.length) {
      return res.status(401).json({ error: "Effect AI auth failed — check authKey" });
    }
    const cookie = setCookie[0].split(";")[0];

    // 3. Import CSV into the existing fetcher
    await axios.post(
      `${effectUrl}/d/${datasetId}/f/${fetcherIndex}/import`,
      new URLSearchParams({ csv, delimiter: "," }).toString(),
      { headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } }
    );

    res.json({ status: "ok", datasetId, fetcherIndex, taskCount: rows.length });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error("postToEffect error:", detail);
    res.status(500).json({ error: "Failed to post to Effect AI", detail: String(detail) });
  }
});

// POST /effectStats — fetch queue counts from an Effect AI fetcher
app.post("/effectStats", async (req, res) => {
  const { authKey, datasetId, fetcherIndex } = req.body;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!authKey || !datasetId || fetcherIndex === undefined) {
    return res.status(400).json({ error: "authKey, datasetId, and fetcherIndex are required" });
  }

  try {
    const authRes = await axios.post(
      `${effectUrl}/auth`,
      new URLSearchParams({ key: authKey }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        maxRedirects: 5,
        validateStatus: s => s < 500,
      }
    );
    const setCookie = authRes.headers["set-cookie"];
    if (!setCookie || !setCookie.length) {
      return res.status(401).json({ error: "Effect AI auth failed — check authKey" });
    }
    const cookie = setCookie[0].split(";")[0];

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
  const { authKey, phase1DatasetId, phase1FetcherIndex } = req.body;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!authKey || !phase1DatasetId || phase1FetcherIndex === undefined) {
    return res.status(400).json({ error: "authKey, phase1DatasetId, phase1FetcherIndex are required" });
  }

  try {
    const authRes = await axios.post(
      `${effectUrl}/auth`,
      new URLSearchParams({ key: authKey }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 5, validateStatus: s => s < 500 }
    );
    const setCookie = authRes.headers["set-cookie"];
    if (!setCookie || !setCookie.length) {
      return res.status(401).json({ error: "Effect AI auth failed — check authKey" });
    }
    const cookie = setCookie[0].split(";")[0];

    const dlRes = await axios.get(
      `${effectUrl}/d/${phase1DatasetId}/f/${phase1FetcherIndex}/download`,
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
  const { authKey, phase1DatasetId, phase1FetcherIndex, phase2DatasetId, phase2FetcherIndex } = req.body;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!authKey || !phase1DatasetId || phase1FetcherIndex === undefined ||
      !phase2DatasetId || phase2FetcherIndex === undefined) {
    return res.status(400).json({ error: "authKey, phase1DatasetId, phase1FetcherIndex, phase2DatasetId, and phase2FetcherIndex are required" });
  }

  try {
    // 1. Auth
    const authRes = await axios.post(
      `${effectUrl}/auth`,
      new URLSearchParams({ key: authKey }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 5, validateStatus: s => s < 500 }
    );
    const setCookie = authRes.headers["set-cookie"];
    if (!setCookie || !setCookie.length) {
      return res.status(401).json({ error: "Effect AI auth failed — check authKey" });
    }
    const cookie = setCookie[0].split(";")[0];

    // 2. Download Phase 1 results CSV
    const dlRes = await axios.get(
      `${effectUrl}/d/${phase1DatasetId}/f/${phase1FetcherIndex}/download`,
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
      `${effectUrl}/d/${phase2DatasetId}/f/${phase2FetcherIndex}/import`,
      new URLSearchParams({ csv: phase2Csv, delimiter: "," }).toString(),
      { headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" } }
    );

    res.json({ status: "ok", taskCount: songs.length, phase2DatasetId, phase2FetcherIndex });
  } catch (err) {
    const detail = err?.response?.data || err?.message || String(err);
    console.error("compileAndPostPhase2 error:", detail);
    res.status(500).json({ error: "Failed to compile and post Phase 2", detail: String(detail) });
  }
});

// POST /downloadPhase2 — proxy the task-poster's result download as a CSV file
app.post("/downloadPhase2", async (req, res) => {
  const { authKey, datasetId, fetcherIndex } = req.body;

  const effectUrl = process.env.EFFECT_URL;
  if (!effectUrl) return res.status(500).json({ error: "EFFECT_URL not configured on server" });
  if (!authKey || !datasetId || fetcherIndex === undefined) {
    return res.status(400).json({ error: "authKey, datasetId, and fetcherIndex are required" });
  }

  try {
    const authRes = await axios.post(
      `${effectUrl}/auth`,
      new URLSearchParams({ key: authKey }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 5, validateStatus: s => s < 500 }
    );
    const setCookie = authRes.headers["set-cookie"];
    if (!setCookie || !setCookie.length) {
      return res.status(401).json({ error: "Effect AI auth failed — check authKey" });
    }
    const cookie = setCookie[0].split(";")[0];

    const dlRes = await axios.get(
      `${effectUrl}/d/${datasetId}/f/${fetcherIndex}/download`,
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
});
