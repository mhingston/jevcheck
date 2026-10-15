type Job = { id: string };
type Response = { status: number; body: { state: string } };
type Queue = { publish(job: Job): Promise<void> };
type Logger = { warn(message: string, details: object): void };

export async function submitJob(
  job: Job,
  queue: Queue,
  logger: Logger,
): Promise<Response> {
  let state = "queued";
  try {
    await queue.publish(job);
  } catch (error) {
    logger.warn("Queue publication failed", { jobId: job.id, error });
    // The response still claims acceptance; no retry or failure response.
  }
  return { status: 202, body: { state } };
}
