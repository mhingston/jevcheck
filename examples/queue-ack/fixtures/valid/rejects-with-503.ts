type Job = { id: string };
type Response = { status: number; body: { state: string } };
type Queue = { publish(job: Job): Promise<void> };
type Logger = { warn(message: string, details: object): void };

export async function acceptJob(
  job: Job,
  queue: Queue,
  logger: Logger,
): Promise<Response> {
  try {
    await queue.publish(job);
  } catch (error) {
    logger.warn("Queue publication failed", { jobId: job.id, error });
    return { status: 503, body: { state: "unavailable" } };
  }
  return { status: 202, body: { state: "queued" } };
}
