import { isOllamaDown, type OllamaClient } from '../ollama.ts';
import { RefsError, errorMessage } from '../util.ts';

/** OCR through the vision model. The reply is stored as text and never acted on. */
export interface Ocr {
  model: string;
  recognize(image: Buffer): Promise<string>;
}

/** Thrown when text can only come from OCR and OCR is not available now; nothing was changed. */
export class OcrUnavailableError extends RefsError {}

const OCR_PROMPT =
  'Transcribe all text in this image exactly as it appears, keeping line breaks, commands, code and punctuation. ' +
  'Output only the transcribed text, with no commentary, no description and no Markdown fences. ' +
  'If the image contains no text, output nothing.';

/** Models sometimes wrap a transcription in a code fence anyway. */
export function cleanOcrText(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  return (fenced ? fenced[1]! : t).trim();
}

export function ocrEngine(client: OllamaClient, model: string): Ocr {
  return {
    model,
    async recognize(image) {
      try {
        return cleanOcrText(await client.vision(model, OCR_PROMPT, [image]));
      } catch (e) {
        if (isOllamaDown(e)) throw new OcrUnavailableError(`OCR needs Ollama, which is not reachable now (${errorMessage(e)})`);
        throw e;
      }
    },
  };
}

export async function ocrImage(ocr: Ocr | null | undefined, buf: Buffer): Promise<string> {
  if (!ocr) throw new OcrUnavailableError('images need OCR, and the vision model is not available now (Ollama down or visionModel not set)');
  return ocr.recognize(buf);
}
