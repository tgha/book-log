// 로컬 시험용: 함수 코드는 그대로 두고 포트만 바꿔서 실행
const port = Number(Deno.env.get("FN_PORT"));
const orig = Deno.serve.bind(Deno);
Object.defineProperty(Deno, "serve", { value: (h: unknown) => orig({ port, onListen: () => console.log("listening", port) }, h as Deno.ServeHandler), configurable: true, writable: true });
await import(Deno.env.get("FN_FILE")!);
