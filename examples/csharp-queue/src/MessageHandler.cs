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
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message); // Logging does not mean publication succeeded.
        }
        return 202; // Broken: acknowledges failed publication.
    }
}

public interface IQueuePublisher
{
    Task PublishAsync(string payload, CancellationToken cancellationToken);
}
