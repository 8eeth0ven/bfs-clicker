// 缺省 skip 词表（工程单 bfs并发卫生 20260926 条2）
// 背景：config.skipTextPatterns 未配置时，带会话爬取把「Logga ut/Log out/注销」等登出钮当普通
// 元素点击——a target site.se 轮实测触发 GET /api/mtw/a target siteid/logout 自号被登出（红线①险情），
// 同轮 BankID order(personalNumber=null) 被自动点出（零真人触达）。
// 语义：命中即跳过该链接/按钮（记录不点击）并打日志；用户 config.skipTextPatterns 叠加
// （合并去重，缺省词表在前为下限，用户词表只会更严不会更松）。
// 匹配沿用上游 substring 语义（text.toLowerCase().includes(词)），过拦方向是"少点不点"，fail-safe。

// 登出/注销形态（en/sv/de/fr/es/it/pt/nl/hu/fi/da/no/cs/sk/pl/tr/et/lv/lt/ru/ja/ko/zh，≥12 要求）
export const DEFAULT_LOGOUT_PATTERNS = [
  // en
  'log out', 'logout', 'log-out', 'log off', 'logoff', 'sign out', 'signout', 'sign-off',
  // sv（a target site 实证词）
  'logga ut', 'ta bort', 'radera', 'avsluta',
  // de
  'abmelden', 'abmelde', 'ausloggen',
  // fr
  'déconnexion', 'se déconnecter', 'deconnexion', 'deconnecter',
  // es
  'cerrar sesión', 'cerrar sesion', 'salir', 'terminar sesión',
  // it
  'esci', 'disconnetti', 'disconnettersi',
  // pt
  'sair', 'encerrar sessão', 'encerrar sessao',
  // nl
  'uitloggen', 'afmelden',
  // hu / fi / da / no / cs / sk / pl / tr / et / lv / lt
  'kijelentkezés', 'kirjaudu ulos', 'log ud', 'log ut', 'odhlásit', 'odhlásiť', 'wyloguj', 'çıkış',
  'välja logima', 'iziet', 'atsijungti',
  // ru / ja / ko / zh
  'выйти', 'サインアウト', 'ログアウト', '로그아웃', '注销', '退出登录', '退出', '登出',
];

// 账号级不可逆动作 + 敏感身份/合规钮（写红线：不自动点）
export const DEFAULT_ACCOUNT_IDENTITY_PATTERNS = [
  'delete account', 'close account', 'cancel account', 'deactivate account',
  'konto löschen', 'konto kündigen', 'supprimer mon compte', 'eliminar mi cuenta',
  'ta bort konto', 'radera konto', '删除账号', '注销账号',
  // 20260926 a target site BankID order(personalNumber=null) 事故
  'bankid', 'bank-id', 'personal-number', 'personalnumber', 'personnummer',
  'national id', 'identity verification', 'kyc',
  // 不可逆销毁。填表正则挡不住普通按钮，必须进默认词表，loadConfig 才会始终合并。
  '销毁',
];

export const DEFAULT_SKIP_TEXT_PATTERNS = [...DEFAULT_LOGOUT_PATTERNS, ...DEFAULT_ACCOUNT_IDENTITY_PATTERNS];
