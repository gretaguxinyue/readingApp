-- 朱批 · Supabase 建表脚本
-- 在 Supabase 控制台 → SQL Editor 里整个粘进去跑一次。

-- ── 书 ──────────────────────────────────────────────
create table if not exists public.books (
  user_id      uuid        not null references auth.users(id) on delete cascade,
  id           text        not null,           -- EPUB 文件内容的 SHA-256 前 32 位
  title        text        not null default '',
  author       text        not null default '',
  spine_len    int         not null default 0,
  storage_path text,                           -- books 桶里的路径
  pos          jsonb       not null default '{"ci":0,"ratio":0}'::jsonb,
  added        timestamptz not null default now(),
  read_at      timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted      boolean     not null default false,
  primary key (user_id, id)
);

-- ── 笔记 ────────────────────────────────────────────
create table if not exists public.notes (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         uuid        not null,
  book_id    text        not null,
  ci         int         not null,             -- 章序号
  start_off  int         not null,             -- 该章纯文本里的起止字符位置
  end_off    int         not null,
  quote      text        not null default '',
  comment    text        not null default '',
  created    timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted    boolean     not null default false,
  primary key (user_id, id)
);

create index if not exists books_updated_idx on public.books (user_id, updated_at);
create index if not exists notes_updated_idx on public.notes (user_id, updated_at);
create index if not exists notes_book_idx    on public.notes (user_id, book_id);

-- ── 只能看自己的东西 ────────────────────────────────
alter table public.books enable row level security;
alter table public.notes enable row level security;

drop policy if exists "own books" on public.books;
create policy "own books" on public.books
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 存放 EPUB 原文件的私有桶 ────────────────────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('books', 'books', false, 104857600)      -- 单个文件上限 100MB
on conflict (id) do nothing;

drop policy if exists "own epub files" on storage.objects;
create policy "own epub files" on storage.objects
  for all to authenticated
  using      (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'books' and (storage.foldername(name))[1] = auth.uid()::text);
