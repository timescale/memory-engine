declare module "mistral-tokenizer-js" {
  const mistralTokenizer: {
    encode(text: string): number[];
    decode(tokens: number[]): string;
  };
  export default mistralTokenizer;
}
