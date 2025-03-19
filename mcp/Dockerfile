FROM python:3.13-slim

WORKDIR /app

# Copy requirements file and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the MCP server files
COPY . .

# Expose port for MCP server
EXPOSE 8100

# Command to run the MCP server
CMD ["python", "mcp_server.py"]
