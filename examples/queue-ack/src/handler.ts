/**
 * Illustrative HTTP job-submission handler. A 202 is the promise that the job
 * reached the queue; the worker itself is asynchronous.
 */
type Job = { id: string; payload: string };
type Response = { status: number; body: { state: string; jobId: string } };
type Queue = { publish(job: Job): Promise<void> };
type Logger = { warn(message: string, details: object): void };

export async function acceptJob(
  job: Job,
  queue: Queue,
  logger: Logger,
): Promise<Response> {
  // This optimistic response is created before publication has succeeded.
  const accepted = { status: 202, body: { state: "queued", jobId: job.id } };

  try {
    await queue.publish(job);
  } catch (error) {
    // Regression: logging is not a successful recovery.
    logger.warn("Queue publication failed", { jobId: job.id, error });
  }

  return accepted; // Also reachable if queue.publish rejects.
}
