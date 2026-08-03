// Simple script node test — echoes input as JSON
const input = process.argv[2] ?? 'no-input';
console.log(JSON.stringify({ echoed: input, timestamp: new Date().toISOString() }));
