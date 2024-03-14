import zodToJsonSchema from 'zod-to-json-schema';
import { LanguageModelV1 } from '../../ai-model-specification/index';
import { CallSettings } from '../prompt/call-settings';
import { convertToLanguageModelPrompt } from '../prompt/convert-to-language-model-prompt';
import { getInputFormat } from '../prompt/get-input-format';
import { Prompt } from '../prompt/prompt';
import { validateCallSettings } from '../prompt/validate-call-settings';
import { Tool } from '../tool';
import { runToolsTransformation } from './run-tools-transformation';
import { StreamTextHttpResponse } from './stream-text-http-response';
import { ToToolCall } from './tool-call';
import { ToToolResult } from './tool-result';

/**
 * Stream text generated by a language model.
 */
export async function streamText<TOOLS extends Record<string, Tool>>({
  model,
  tools,
  system,
  prompt,
  messages,
  ...settings
}: CallSettings &
  Prompt & {
    model: LanguageModelV1;
    tools?: TOOLS;
  }): Promise<StreamTextResult<TOOLS>> {
  const { stream, warnings } = await model.doStream({
    mode: {
      type: 'regular',
      tools:
        tools == null
          ? undefined
          : Object.entries(tools).map(([name, tool]) => ({
              type: 'function',
              name,
              description: tool.description,
              parameters: zodToJsonSchema(tool.parameters),
            })),
    },
    ...validateCallSettings(settings),
    inputFormat: getInputFormat({ prompt, messages }),
    prompt: convertToLanguageModelPrompt({
      system,
      prompt,
      messages,
    }),
  });

  const toolStream = runToolsTransformation({
    tools,
    generatorStream: stream,
  });

  return new StreamTextResult(toolStream);
}

export type TextStreamPart<TOOLS extends Record<string, Tool>> =
  | {
      type: 'text-delta';
      textDelta: string;
    }
  | ({
      type: 'tool-call';
    } & ToToolCall<TOOLS>)
  | {
      type: 'error';
      error: unknown;
    }
  | ({
      type: 'tool-result';
    } & ToToolResult<TOOLS>);

export class StreamTextResult<TOOLS extends Record<string, Tool>> {
  private readonly rootStream: ReadableStream<TextStreamPart<TOOLS>>;

  readonly textStream: AsyncIterable<string>;

  readonly fullStream: AsyncIterable<TextStreamPart<TOOLS>>;

  constructor(stream: ReadableStream<TextStreamPart<TOOLS>>) {
    this.rootStream = stream;

    this.textStream = {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        const reader = stream.getReader();
        return {
          next: async () => {
            // loops until a text delta is found or the stream is finished:
            while (true) {
              const { done, value } = await reader.read();

              if (done) {
                return { value: null, done: true };
              }

              if (value.type === 'text-delta') {
                // do not stream empty text deltas:
                if (value.textDelta.length > 0) {
                  return { value: value.textDelta, done: false };
                }
              }

              if (value.type === 'error') {
                // TODO log / store errors
                console.error('Error:', value.error);
              }
            }
          },
        };
      },
    };

    this.fullStream = {
      [Symbol.asyncIterator](): AsyncIterator<TextStreamPart<TOOLS>> {
        const reader = stream.getReader();
        return {
          next: async () => {
            // loops until a valid delta is found or the stream is finished:
            while (true) {
              const { done, value } = await reader.read();

              if (done) {
                return { value: null, done: true };
              }

              if (value.type === 'text-delta') {
                // do not stream empty text deltas:
                if (value.textDelta.length > 0) {
                  return { value, done: false };
                }
              } else {
                return { value, done: false };
              }
            }
          },
        };
      },
    };
  }

  toResponse() {
    return new StreamTextHttpResponse(this.rootStream);
  }
}
