declare module "markdown-it-mark" {
  import type MarkdownIt from "markdown-it";
  const mark: (md: MarkdownIt) => void;
  export default mark;
}
