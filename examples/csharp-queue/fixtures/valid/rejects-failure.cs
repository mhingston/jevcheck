using System;
using System.Threading;
using System.Threading.Tasks;

public sealed class MessageHandler
{
    private readonly IQueuePublisher queue;
    public MessageHandler(IQueuePublisher queue) => this.queue = queue;

    public async Task<int> HandleAsync(string payload, CancellationToken cancellationToken)
    {
        try
        {
            await queue.PublishAsync(payload, cancellationToken);
            return 202;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 503; // Never acknowledge a failed publish as accepted.
        }
    }
}

public interface IQueuePublisher
{
    Task PublishAsync(string payload, CancellationToken cancellationToken);
}
