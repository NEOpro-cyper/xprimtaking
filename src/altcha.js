/**
 * Parallel ARGON2ID Altcha Solver
 *
 * Uses child_process.fork() for worker isolation.
 * Each child tries counters offset by its worker index (stride = NUM_WORKERS),
 * so all 4 workers search in parallel without overlap.
 *
 * child_process provides better isolation than worker_threads —
 * if a child crashes, it doesn't take down the parent.
 */

import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NUM_WORKERS = Math.min(availableParallelism(), parseInt(process.env.WORKERS || '4') || 4);

/**
 * Solve an Altcha challenge using parallel child processes.
 * Returns the base64 token + solve metrics.
 */
export async function solveAltchaParallel() {
  // 1. Fetch challenge
  const resp = await fetch('https://mznxiwqjdiq00239q.space/altcha/challenge');
  if (!resp.ok) throw new Error(`Altcha challenge fetch failed: ${resp.status}`);
  const challenge = await resp.json();

  // 2. Distribute across workers
  const { token, solveTime, counter, workerIndex } = await raceWorkers(challenge);

  return { token, solveTime, counter, workerIndex, workers: NUM_WORKERS };
}

/**
 * Fork NUM_WORKERS child processes and race them.
 * First to find the answer wins; all others are killed.
 */
function raceWorkers(challenge) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const children = [];

    for (let i = 0; i < NUM_WORKERS; i++) {
      const child = fork(path.join(__dirname, 'altcha-worker.js'), [], {
        env: {
          ...process.env,
          CHALLENGE_DATA: JSON.stringify(challenge),
          WORKER_INDEX: String(i),
          TOTAL_WORKERS: String(NUM_WORKERS),
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      child.on('message', (msg) => {
        if (settled) return;
        settled = true;

        const solveTime = Date.now() - msg.solveStart;

        // Kill all children — we found the answer
        for (const c of children) {
          try { c.kill('SIGTERM'); } catch {}
        }

        // Build xprime-format base64 token
        const token = Buffer.from(JSON.stringify({
          algorithm: challenge.parameters.algorithm,
          cost: challenge.parameters.cost,
          expiresAt: challenge.parameters.expiresAt,
          keyLength: challenge.parameters.keyLength,
          keyPrefix: challenge.parameters.keyPrefix,
          keySignature: challenge.parameters.keySignature,
          memoryCost: challenge.parameters.memoryCost,
          nonce: challenge.parameters.nonce,
          parallelism: challenge.parameters.parallelism,
          salt: challenge.parameters.salt,
          signature: challenge.signature,
          counter: msg.counter,
          derivedKey: msg.derivedKey,
          took: solveTime,
        })).toString('base64');

        resolve({ token, solveTime, counter: msg.counter, workerIndex: i });
      });

      child.on('error', (err) => {
        if (!settled) {
          console.error(`[WORKER ${i}] Error: ${err.message}`);
        }
      });

      child.on('exit', (code) => {
        // Child exited — if error and not settled, log it
        if (code && code !== 0 && !settled) {
          console.error(`[WORKER ${i}] Exited with code ${code}`);
        }
      });

      children.push(child);
    }

    // Safety timeout — 120s
    setTimeout(() => {
      if (!settled) {
        settled = true;
        for (const c of children) {
          try { c.kill('SIGTERM'); } catch {}
        }
        reject(new Error('All workers timed out after 120s'));
      }
    }, 120_000);
  });
}
