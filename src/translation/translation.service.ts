import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SUPPORTED_LANGUAGE_CODES as SUPPORTED } from '../common/languages';


const MAX_TEXTS = 100;
const MAX_TEXT_LENGTH = 5000;

@Injectable()
export class TranslationService {
  async batch(targetLanguage: string, texts: string[]) {
    const target = targetLanguage.toLowerCase().split(/[-_]/)[0];
    if (!SUPPORTED.has(target)) throw new BadRequestException('Unsupported target language');
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS) {
      throw new BadRequestException(`texts must contain 1-${MAX_TEXTS} items`);
    }
    if (texts.some((text) => typeof text !== 'string' || text.length > MAX_TEXT_LENGTH)) {
      throw new BadRequestException(`Each text must be a string of ${MAX_TEXT_LENGTH} characters or fewer`);
    }
    if (target === 'en') return { translations: texts };

    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    if (!apiKey) {
      // Translation is an enhancement, never a reason for the app to fail.
      // The client keeps the original English text as its offline fallback.
      return { translations: texts, translated: false };
    }

    const response = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: texts,
          target,
          source: 'en',
          format: 'text',
        }),
      },
    );

    if (!response.ok) {
      throw new ServiceUnavailableException('Translation provider is temporarily unavailable');
    }

    const body = (await response.json()) as {
      data?: { translations?: Array<{ translatedText?: string }> };
    };
    const translated = body.data?.translations?.map((item) => item.translatedText ?? '');
    if (!translated || translated.length !== texts.length) {
      throw new ServiceUnavailableException('Translation provider returned an invalid response');
    }

    return { translations: translated, translated: true };
  }
}
