#!/usr/bin/env python3
import argparse
import os
import sys
import shutil
import requests
import json
import torch
import time

# Demucs imports
try:
    from demucs.separate import main as demucs_cli_main
except Exception as e:
    demucs_cli_main = None

# Whisper imports
import whisper
from whisper.utils import get_writer


def info(msg: str):
    print(f"[INFO] {msg}", flush=True)


def err(msg: str):
    print(f"[ERROR] {msg}", flush=True, file=sys.stderr)


def download_to(path: str, url: str, retries: int = 5):
    # Audius creator nodes reject non-browser user-agents
    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://audius.co/",
    }
    attempts = 0

    while attempts < retries:
        try:
            print(f"Downloading: {url}")
            with requests.get(url, stream=True, timeout=(300, 300), headers=headers) as r:
                r.raise_for_status()
                with open(path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
            print(f"Saved: {path}")
            return path
        except Exception as e:
            err(e)
            attempts += 1
            if attempts < retries:
                print(f"[INFO] Retrying in 15s... (attempt {attempts}/{retries})")
                time.sleep(15)

    raise RuntimeError(f"Failed to download {url} after {retries} attempts")


def run_demucs(input_audio: str, out_dir: str, model: str, two_stems: str | None, shifts: int, overlap: float, jobs: int):
    args = [
        "-n", model,
        "-o", out_dir,
        "--shifts", str(shifts),
        "--overlap", str(overlap),
        "-j", str(jobs),
        "--mp3"
    ]
    if two_stems:
        args += ["--two-stems", two_stems]

    info(f"Running Demucs: model={model}, two_stems={two_stems}, input={input_audio}")
    demucs_cli_main(args + [input_audio])
    info("Demucs complete")


def run_whisper_on_file(
        audio_path: str,
        whisper_model_name: str,
        language: str | None,
        output_dir: str,
        basename: str,
        output_format: str = "srt"
    ):
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    info(f"Loading Whisper model '{whisper_model_name}' on {device}")

    wmodel = whisper.load_model(whisper_model_name, device=device)
    fp16 = device == "cuda"

    info(f"Transcribing with Whisper (fp16={fp16}, language={language or 'auto'})")
    result = wmodel.transcribe(
        audio_path,
        fp16=fp16,
        language=language,
        temperature=0.0,
        condition_on_previous_text=False,
        verbose=False
    )

    text = result["text"].strip()
    ensure_dir(output_dir)

    # Write transcript
    writer = get_writer(output_format, output_dir)
    writer(result, audio_path)

    generated_files = [f for f in os.listdir(output_dir) if f.endswith(f".{output_format}")]
    if not generated_files:
        raise FileNotFoundError("Whisper did not produce an output file")
    
    generated_path = os.path.join(output_dir, generated_files[0])
    output_path = os.path.join(output_dir, f"{basename}.{output_format}")
    
    # Rename/move to desired basename
    os.replace(generated_path, output_path)

    info(f"Wrote transcript to {output_path}")
    return text, output_path


def find_vocals_mp3(demucs_out_root: str, model: str, input_basename: str) -> str:
    vocals_path = os.path.join(demucs_out_root, model, input_basename, "vocals.mp3")
    if os.path.exists(vocals_path):
        return vocals_path
    for root, _, files in os.walk(demucs_out_root):
        if "vocals.mp3" in files:
            return os.path.join(root, "vocals.mp3")
    raise FileNotFoundError("Could not locate vocals.mp3 in Demucs output")


def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)
    return path


def main():
    parser = argparse.ArgumentParser(description="Demucs + Whisper pipeline")
    parser.add_argument("--jobID", type=str, default=None, help="ID of current job")
    parser.add_argument("--url", type=str, default=None, help="Remote URL to an MP3 or WAV")
    parser.add_argument("--input", type=str, default=None, help="Existing file path, e.g. /data/input/song.mp3")
    parser.add_argument("--output_dir", type=str, default="/data/output", help="Where to write final assets")
    parser.add_argument("--tmp_dir", type=str, default="/tmp", help="Scratch workspace")
    parser.add_argument("--model", type=str, default="htdemucs", help="Demucs model name")
    parser.add_argument("--two_stems", type=str, default="vocals", help="Demucs two stems target, set empty to disable")
    parser.add_argument("--shifts", type=int, default=1, help="Demucs shifts")
    parser.add_argument("--overlap", type=float, default=0.25, help="Demucs overlap")
    parser.add_argument("--jobs", type=int, default=1, help="Demucs CPU worker threads")
    parser.add_argument("--whisper_model", type=str, default="medium", help="Whisper model size")
    parser.add_argument("--language", type=str, default=None, help="Language code for Whisper. Empty = auto")
    args = parser.parse_args()

    out_dir = ensure_dir(args.output_dir)
    work_dir = ensure_dir(os.path.join(args.tmp_dir, "demucs_whisper_work"))

    try:
        if args.url:
            filename = os.path.basename(args.url.split("?")[0]) or "input.mp3"
            input_path = os.path.join(work_dir, filename)
            download_to(input_path, args.url)
        elif args.input:
            input_path = args.input
            if not os.path.exists(input_path):
                raise FileNotFoundError(f"Input not found: {input_path}")
        else:
            raise ValueError("You must pass either --url or --input")

        basename_noext = os.path.splitext(os.path.basename(input_path))[0]

        # Run Demucs
        demucs_out_root = os.path.join(work_dir, "demucs_out")
        ensure_dir(demucs_out_root)
        run_demucs(
            input_audio=input_path,
            out_dir=demucs_out_root,
            model=args.model,
            two_stems=args.two_stems or None,
            shifts=args.shifts,
            overlap=args.overlap,
            jobs=args.jobs,
        )

        vocals_path = find_vocals_mp3(demucs_out_root, args.model, basename_noext)
        info(f"Found vocals at {vocals_path}")

        text, transcript_path = run_whisper_on_file(
            audio_path=vocals_path,
            whisper_model_name=args.whisper_model,
            language=args.language,
            output_dir=out_dir,
            basename=basename_noext,
            output_format="srt"
        )

        # Copy vocals to output
        vocals_out_path = os.path.join(out_dir, f"{basename_noext}_vocals.mp3")
        shutil.copy2(vocals_path, vocals_out_path)
        info(f"Copied vocals to {vocals_out_path}")

        with open(transcript_path, "r", encoding="utf-8") as f:
            srt_content = f.read()
    
        try:
            resp = requests.post(
                "https://lyricfai-api.onrender.com/addSong",
                json={"lyrics": srt_content, "jobID":args.jobID, "songUrl": args.url},
            )
            resp.raise_for_status()
            info(f"Transcript sent successfully: {resp.status_code}")
        except Exception as e:
            err(f"Failed to send transcript: {e}")


        info("Pipeline complete")

    except Exception as e:
        err(str(e))
        sys.exit(1)



if __name__ == "__main__":
    main()
