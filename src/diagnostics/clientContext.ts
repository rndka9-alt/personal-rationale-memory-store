import { AsyncLocalStorage } from "node:async_hooks";

// MCP 전송 계층에서 확보한 클라이언트 메타데이터. LLM의 자기 신고가 아니라
// initialize 핸드셰이크(clientInfo)와 HTTP 헤더에서만 채운다.
export type ClientContext = {
  clientName?: string;
  clientVersion?: string;
  userAgent?: string;
};

// 관측 전용 데이터를 도메인 서비스 시그니처에 싣지 않기 위한 요청 스코프 저장소.
// HTTP 요청 처리를 runWithClientContext로 감싸면 그 안에서 실행되는 도구 핸들러와
// 쿼리 로깅이 readClientContext로 같은 값을 읽는다.
const clientContextStorage = new AsyncLocalStorage<ClientContext>();

export function runWithClientContext<T>(context: ClientContext, callback: () => T): T {
  return clientContextStorage.run(context, callback);
}

// stdio 전송처럼 컨텍스트를 세팅하지 않는 경로에서는 undefined를 반환한다.
export function readClientContext(): ClientContext | undefined {
  return clientContextStorage.getStore();
}
