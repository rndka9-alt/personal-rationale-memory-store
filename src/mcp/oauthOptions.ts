import { readFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import type { OAuthServerOptions } from "./oauth.js";

type OAuthEnvironmentConfig = AppConfig["mcp"]["oauth"];

/**
 * 환경변수에서 읽은 OAuth 설정을 authorization server가 쓰는 값으로 해석한다.
 * 필수값 검증, 서명키 파일 읽기, 환경변수 개행 이스케이프 복원처럼
 * 환경변수라는 표현 방식에 묶인 처리는 전부 이 경계에서 끝낸다.
 * OAuth가 꺼져 있으면 undefined를 돌려주므로 호출자가 서버 생성 여부를 판단할 수 있다.
 */
export function resolveOAuthServerOptions(oauth: OAuthEnvironmentConfig): OAuthServerOptions | undefined {
  if (!oauth.enabled) {
    return undefined;
  }

  if (!oauth.publicUrl) {
    throw new Error("MCP_PUBLIC_URL is required when MCP_OAUTH_ENABLED=true.");
  }
  if (oauth.redirectUris.length === 0) {
    throw new Error("At least one OAuth redirect URI is required when MCP_OAUTH_ENABLED=true.");
  }
  if (!oauth.loginCode) {
    throw new Error("MCP_OAUTH_LOGIN_CODE is required when MCP_OAUTH_ENABLED=true.");
  }

  return {
    issuer: oauth.publicUrl,
    clientId: oauth.clientId,
    redirectUris: oauth.redirectUris,
    loginCode: oauth.loginCode,
    signingPrivateKeyPem: readSigningPrivateKeyPem(oauth),
    accessTokenTtlSeconds: oauth.accessTokenTtlSeconds,
    loginSessionTtlSeconds: oauth.loginSessionTtlSeconds,
    userSubject: oauth.userSubject,
    scopes: oauth.scopes,
    requiredScopes: oauth.requiredScopes
  };
}

function readSigningPrivateKeyPem(oauth: OAuthEnvironmentConfig) {
  if (oauth.signingPrivateKeyPath && oauth.signingPrivateKeyPem) {
    throw new Error("Set only one of MCP_OAUTH_SIGNING_PRIVATE_KEY_PATH or MCP_OAUTH_SIGNING_PRIVATE_KEY_PEM.");
  }

  if (oauth.signingPrivateKeyPath) {
    return readFileSync(oauth.signingPrivateKeyPath, "utf8");
  }

  // 환경변수로 넘긴 PEM은 개행이 리터럴 \n 두 글자로 들어오는 경우가 있다.
  if (oauth.signingPrivateKeyPem) {
    return oauth.signingPrivateKeyPem.replace(/\\n/g, "\n");
  }

  return undefined;
}
