import { APIGatewayProxyResult } from 'aws-lambda';
import type { VoicevoxWarmupResponse } from 'generative-ai-use-cases';
import { ensureMicrovm, loadVoicevoxConfig } from './utils/voicevoxMicrovm';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

/**
 * POST /voicevox/warmup
 * Make sure a MicroVM exists and return its state immediately.
 * It does not wait for RUNNING (API Gateway times out at 29s).
 */
export const handler = async (): Promise<APIGatewayProxyResult> => {
  const config = loadVoicevoxConfig();
  if (!config) {
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ message: 'VOICEVOX is not enabled.' }),
    };
  }
  try {
    const info = await ensureMicrovm(config);
    const response: VoicevoxWarmupResponse = { state: info.state };
    return { statusCode: 200, headers, body: JSON.stringify(response) };
  } catch (error) {
    console.log(error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'Internal Server Error' }),
    };
  }
};
