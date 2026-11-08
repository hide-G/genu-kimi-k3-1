import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib';
import {
  processedStackInputSchema,
  stackInputSchema,
} from '../lib/stack-input';
import { createStacks } from '../lib/create-stacks';
import { stackInput } from './stack-input.fixture';
import {
  BUNDLING_STACKS,
  DISABLE_ASSET_STAGING_CONTEXT,
} from 'aws-cdk-lib/cx-api';

const IMAGE_ARN = 'arn:aws:lambda:ap-northeast-1:111111111111:microvm-image:v';

const synth = (overrides: Record<string, unknown>) => {
  const app = new cdk.App({
    context: {
      [BUNDLING_STACKS]: [],
      [DISABLE_ASSET_STAGING_CONTEXT]: true,
    },
  });
  const params = processedStackInputSchema.parse({
    ...stackInput,
    ...overrides,
  });
  const { generativeAiUseCasesStack } = createStacks(app, params);
  if (!generativeAiUseCasesStack) throw new Error('stack was not created');
  return Template.fromStack(generativeAiUseCasesStack);
};

const apiPathParts = (template: Template) =>
  Object.values(template.findResources('AWS::ApiGateway::Resource')).map(
    (r) => r.Properties.PathPart
  );

const allIamActions = (template: Template) =>
  Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p) =>
    p.Properties.PolicyDocument.Statement.flatMap(
      (s: { Action: string | string[] }) => s.Action
    )
  );

describe('voicevox parameter', () => {
  it('creates no VOICEVOX routes / IAM when not specified', () => {
    const template = synth({});
    expect(apiPathParts(template)).not.toContain('voicevox');
    expect(allIamActions(template)).not.toContain('lambda:RunMicrovm');
    expect(allIamActions(template)).not.toContain(
      'lambda:PassNetworkConnector'
    );
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ VOICEVOX_MICROVM_IMAGE_ARN: '' }),
      },
    });
  });

  it('creates no VOICEVOX routes when enabled=false', () => {
    const template = synth({
      voicevox: {
        enabled: false,
        region: 'ap-northeast-1',
        microvmImageArn: IMAGE_ARN,
      },
    });
    expect(apiPathParts(template)).not.toContain('voicevox');
    expect(allIamActions(template)).not.toContain('lambda:RunMicrovm');
  });

  it('creates routes, scoped IAM and settings when enabled', () => {
    const template = synth({
      voicevox: {
        enabled: true,
        region: 'ap-northeast-1',
        microvmImageArn: IMAGE_ARN,
      },
    });
    const parts = apiPathParts(template);
    expect(parts).toEqual(
      expect.arrayContaining(['voicevox', 'warmup', 'synthesize'])
    );
    expect(allIamActions(template)).toEqual(
      expect.arrayContaining([
        'lambda:RunMicrovm',
        'lambda:GetMicrovm',
        'lambda:ListMicrovms',
        'lambda:CreateMicrovmAuthToken',
        'lambda:PassNetworkConnector',
      ])
    );
    // PassNetworkConnector is limited to the two connectors
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:PassNetworkConnector',
            Resource: [
              'arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:ALL_INGRESS',
              'arn:aws:lambda:ap-northeast-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS',
            ],
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          VOICEVOX_REGION: 'ap-northeast-1',
          VOICEVOX_MICROVM_IMAGE_ARN: IMAGE_ARN,
          VOICEVOX_ENGINE_PORT: '50021',
        }),
      },
    });
    expect(template.toJSON().Outputs.VoicevoxEnabled.Value).toBe('true');
  });

  it('fails at synthesis together with closedNetworkMode', () => {
    expect(() =>
      stackInputSchema.parse({
        ...stackInput,
        closedNetworkMode: true,
        voicevox: {
          enabled: true,
          region: 'ap-northeast-1',
          microvmImageArn: IMAGE_ARN,
        },
      })
    ).toThrow(/closedNetworkMode/);
  });

  it('rejects an image name that is not an ARN', () => {
    expect(() =>
      stackInputSchema.parse({
        ...stackInput,
        voicevox: {
          enabled: true,
          region: 'ap-northeast-1',
          microvmImageArn: 'voicevox-cobaco-v2',
        },
      })
    ).toThrow(/microvmImageArn/);
  });
});
