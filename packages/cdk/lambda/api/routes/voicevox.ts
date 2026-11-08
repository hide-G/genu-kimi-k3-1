import { Router } from 'express';
import { handler as voicevoxWarmupHandler } from '../../voicevoxWarmup';
import { handler as voicevoxSynthesizeHandler } from '../../voicevoxSynthesize';
import { wrapHandler } from './helpers';

export const router = Router();

router.post('/warmup', wrapHandler(voicevoxWarmupHandler));
router.post('/synthesize', wrapHandler(voicevoxSynthesizeHandler));
