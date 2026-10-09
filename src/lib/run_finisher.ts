export type RunFinisherPhase = 'auth' | 'finish';

export class RunFinisherError extends Error {
    constructor(
        public readonly phase: RunFinisherPhase,
        public readonly status: number,
        public readonly statusText: string,
        public readonly errorText: string,
    ) {
        super(`Backend ${phase} request failed: ${status} ${statusText}`);
        this.name = 'RunFinisherError';
    }
}

export async function finishRunViaBackend(
    backendUrl: string,
    runId: string,
    fetchImpl: typeof fetch = fetch,
): Promise<{ message?: string }> {
    // Empty bodies ensure Content-Length is sent (avoids HTTP 411 on some proxies).
    const authResponse = await fetchImpl(`${backendUrl}/auth/run/${runId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: '',
    });

    if (!authResponse.ok) {
        const errorText = await authResponse.text().catch(() => 'Unknown error');
        throw new RunFinisherError('auth', authResponse.status, authResponse.statusText, errorText);
    }

    const authData = await authResponse.json() as { token: string };

    const response = await fetchImpl(`${backendUrl}/finish/${runId}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authData.token}`,
        },
        body: '',
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new RunFinisherError('finish', response.status, response.statusText, errorText);
    }

    return await response.json() as { message?: string };
}
