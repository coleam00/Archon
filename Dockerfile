FROM python:3.12-slim

WORKDIR /app

# Install system dependencies including minimal Playwright dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libwoff1 \
    libevent-2.1-7 \
    libgstreamer-gl1.0-0 \
    libgstreamer-plugins-bad1.0-0 \
    libharfbuzz-icu0 \
    libenchant-2-2 \
    libhyphen0 \
    libmanette-0.2-0 \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browsers
RUN python -m playwright install chromium

# Copy the rest of the application
COPY . .

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# Expose port for Streamlit
EXPOSE 8501

# Expose port for the Archon Service (started within Streamlit)
EXPOSE 8100

# Set the entrypoint to run Streamlit directly
CMD ["streamlit", "run", "streamlit_ui.py", "--server.port=8501", "--server.address=0.0.0.0"]
