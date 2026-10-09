import { finishRunViaBackend, RunFinisherError } from '../src/lib/run_finisher';

describe('finishRunViaBackend', () => {
  it('authenticates and finishes the run with the bearer token', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Finished' }), { status: 200 }));

    await expect(finishRunViaBackend('https://backend.example', 'run-123', fetchImpl)).resolves.toEqual({
      message: 'Finished',
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://backend.example/auth/run/run-123',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '',
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://backend.example/finish/run-123',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer jwt-token',
        },
        body: '',
      }),
    );
  });

  it('reports authentication failures for cleanup to handle as fallback', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    await expect(finishRunViaBackend('https://backend.example', 'run-123', fetchImpl)).rejects.toMatchObject({
      name: 'RunFinisherError',
      phase: 'auth',
      status: 401,
      statusText: 'Unauthorized',
      errorText: 'unauthorized',
    } satisfies Partial<RunFinisherError>);
  });

  it('reports finish failures after successful authentication', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'jwt-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('backend unavailable', { status: 503, statusText: 'Unavailable' }));

    await expect(finishRunViaBackend('https://backend.example', 'run-123', fetchImpl)).rejects.toMatchObject({
      phase: 'finish',
      status: 503,
      statusText: 'Unavailable',
      errorText: 'backend unavailable',
    });
  });
});
