# CUDA enabled Python with PyTorch
FROM pytorch/pytorch:2.3.1-cuda12.1-cudnn8-runtime

# System deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg git && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Python deps
# demucs pulls torchaudio, dora-search, julius, etc.
# whisper is openai-whisper
RUN pip install --no-cache-dir \
    openai-whisper==20231117 \
    demucs==4.0.1 \
    soundfile==0.12.1 \
    numpy==1.26.4 \
    requests==2.32.3

# Create app dir
WORKDIR /app
COPY pipeline.py /app/pipeline.py

# Pre-download Whisper model during build
RUN python3 - <<EOF
import whisper
whisper.load_model("medium")
EOF

# Create standard Nosana dirs
RUN mkdir -p /data/input /data/output /models

# Default command. You will pass flags at runtime.
ENTRYPOINT ["python", "/app/pipeline.py"]
