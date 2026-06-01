/**
 * Altcha Worker Child Process
 *
 * Reads challenge data from environment variables and tries counters
 * in stride: workerIndex, workerIndex + totalWorkers, etc.
 *
 * Communicates result back to parent via IPC (process.send).
 */

import argon2 from 'argon2';

const challenge = JSON.parse(process.env.CHALLENGE_DATA);
const workerIndex = parseInt(process.env.WORKER_INDEX);
const totalWorkers = parseInt(process.env.TOTAL_WORKERS);
const p = challenge.parameters;

const nonceBuf = Buffer.from(p.nonce, 'hex');
const saltBuf = Buffer.from(p.salt, 'hex');
const solveStart = Date.now();

for (let counter = workerIndex; counter <= 500000; counter += totalWorkers) {
  const password = Buffer.alloc(nonceBuf.length + 4);
  nonceBuf.copy(password, 0);
  password.writeUInt32BE(counter, nonceBuf.length);

  const hashBuf = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: p.memoryCost,
    timeCost: p.cost,
    parallelism: p.parallelism,
    hashLength: p.keyLength,
    salt: saltBuf,
    raw: true,
  });

  const hashHex = hashBuf.toString('hex');
  if (hashHex.startsWith(p.keyPrefix)) {
    process.send({
      counter,
      derivedKey: hashHex,
      solveStart,
    });
    process.exit(0);
  }
}

// Exhausted range without finding
process.exit(0);
