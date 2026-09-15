const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(desktopRoot, "src", "App.tsx"), "utf8");
const freeCreation = fs.readFileSync(path.join(desktopRoot, "src", "components", "FreeCreationPage.tsx"), "utf8");
const reviewTip = fs.readFileSync(path.join(desktopRoot, "src", "components", "VideoContentReviewTip.tsx"), "utf8");
const styles = fs.readFileSync(path.join(desktopRoot, "src", "styles.css"), "utf8");

test("video prompts show the content review tip in free creation and storyboard", () => {
  assert.match(freeCreation, /<VisualMentionEditor[^>]*ariaLabel="自由创作视频提示词"[^>]*\/>\s*<VideoContentReviewTip \/>/s);
  assert.match(app, /ariaLabel="视频生成提示词" \/><VideoContentReviewTip \/><div className="shot-prompt-actions">/s);
  assert.match(reviewTip, /避免家暴、虐待老人及涉及未成年人的内容/);
  assert.match(reviewTip, /可更换其他模型后重试/);
  assert.match(styles, /\.video-content-review-tip \{[^}]*var\(--ui-warning-border\)[^}]*var\(--ui-warning-soft\)/s);
});
