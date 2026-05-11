// Malicious: eval-based RCE
const userInput = process.argv[2];
eval(userInput);
