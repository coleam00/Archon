import { exec } from 'node:child_process';
// Unsafe shell exec with user input
const userCmd = process.argv[2];
exec(userCmd, { shell: true });
