# Claude 지침

## 필수: 작업 시작 전

```bash
nvm use
```

## 명령어

| 명령어 | 설명 |
|--------|------|
| `pnpm dev` | 개발 서버 (Tauri + Vite) |
| `pnpm tauri build` | 프로덕션 빌드 |
| `pnpm build` | 프론트엔드만 빌드 |

## 프로젝트 구조

```
src/                    # React 프론트엔드
├── App.tsx             # 메인 컴포넌트 (단일 파일)
├── App.css             # 스타일
└── main.tsx            # 엔트리포인트

src-tauri/              # Rust 백엔드
├── src/
│   ├── lib.rs          # Tauri 명령어 (PTY, Git, 파일 시스템)
│   └── main.rs         # 엔트리포인트
├── tauri.conf.json     # Tauri 설정
└── Cargo.toml          # Rust 의존성
```

## 아키텍처

- **단일 파일 구조**: 모든 React 코드가 `App.tsx`에 있음
- **상태 관리**: localStorage (인증, 필터, 테마, 단축키)
- **Jira API**: Tauri HTTP 플러그인으로 직접 호출
- **터미널**: Rust PTY + xterm.js
- **Git/GitHub**: Rust에서 CLI 명령어 실행

## Tauri 명령어 (lib.rs)

| 명령어 | 설명 |
|--------|------|
| `create_pty_session` | 터미널 세션 생성 |
| `write_to_pty` | 터미널 입력 |
| `resize_pty` | 터미널 크기 조절 |
| `run_git_command` | Git 명령 실행 |
| `run_gh_command` | GitHub CLI 실행 |
| `read_file` / `write_file` | 파일 읽기/쓰기 |

## 주의사항

- 토큰은 localStorage에 저장됨 (소스에 하드코딩 금지)
- `tauri.conf.json`에 Apple 서명 ID 포함 (개인정보 주의)
- **CSS 수정 시 테마 기능 필수 고려**: 모든 색상/스타일은 CSS 변수(`--변수명`) 사용. `App.tsx`의 `DEFAULT_THEME_TEMPLATE` 참조. 하드코딩된 색상값 사용 금지
- **앱 이름/아이콘 변경 후 반드시 `pnpm tauri build`로 재빌드**: macOS 앱 이름은 빌드 시 `productName`에서 가져옴
