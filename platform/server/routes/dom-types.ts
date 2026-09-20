// Browser-only DOM type aliases. This file does NOT depend on `lib: dom`;
// it declares the minimal surface the exploration wire uses. Keeping the
// types in a separate file lets `platform/server/index.ts` compile under
// the Node tsconfig without dragging in the DOM lib.

export type Elem = {
  tagName: string;
  textContent: string | null;
  getAttribute: (n: string) => string | null;
  parentElement: Elem | null;
};

export type ElemWithHandle = Elem & {
  click(opts: { timeout: number }): Promise<void>;
  hover(): Promise<void>;
  fill(v: string): Promise<void>;
  selectOption(v: string): Promise<void>;
};
