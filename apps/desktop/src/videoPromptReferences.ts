import type { GenerationReferenceAssetInput } from "@aivs/schemas";

export interface VideoPromptMention {
  token: string;
  relativePath?: string;
  kind: GenerationReferenceAssetInput["kind"];
}

const kindOrder: Record<GenerationReferenceAssetInput["kind"], number> = {
  scene: 0,
  character: 1,
  prop: 2,
  shot_reference: 3,
  shot_first_frame: 3,
};

function normalizedPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Keep the model's image array deterministic: scene, characters, props, then storyboard image. */
export function orderedVideoReferences(references: GenerationReferenceAssetInput[]): GenerationReferenceAssetInput[] {
  const seen = new Set<string>();
  return references
    .map((reference, index) => ({ reference, index }))
    .sort((left, right) => kindOrder[left.reference.kind] - kindOrder[right.reference.kind] || left.index - right.index)
    .flatMap(({ reference }) => {
      const path = normalizedPath(reference.relative_path);
      if ((reference.kind === "scene" || reference.kind === "character" || reference.kind === "prop") && seen.has(path)) return [];
      if (reference.kind === "scene" || reference.kind === "character" || reference.kind === "prop") seen.add(path);
      return [reference];
    });
}

/**
 * Stored prompts keep friendly @ tokens. Only the outbound prompt is converted to
 * the reference-image ordinals understood by the video model.
 */
export function prepareVideoPromptSubmission(
  prompt: string,
  references: GenerationReferenceAssetInput[],
  mentions: VideoPromptMention[],
): { prompt: string; references: GenerationReferenceAssetInput[] } {
  const ordered = orderedVideoReferences(references);
  const replacements = mentions.flatMap((mention) => {
    if (!mention.relativePath) return [];
    const path = normalizedPath(mention.relativePath);
    const index = ordered.findIndex((reference) => reference.kind === mention.kind && normalizedPath(reference.relative_path) === path);
    return index < 0 ? [] : [{ token: mention.token, replacement: `参考图${index + 1}` }];
  }).sort((left, right) => right.token.length - left.token.length);

  return {
    prompt: replacements.reduce((value, item) => value.split(item.token).join(item.replacement), prompt),
    references: ordered,
  };
}
