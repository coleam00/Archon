FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir \
    fastapi==0.104.1 \
    uvicorn==0.24.0 \
    httpx==0.25.1 \
    openai==1.3.7 \
    python-multipart==0.0.6 \
    pydantic==2.5.0

# Copy application
COPY main.py .

# Expose port
EXPOSE 3738

# Run voice UI
CMD ["python", "main.py"]
