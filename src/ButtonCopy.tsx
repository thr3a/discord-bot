import { Button } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCheck, IconCopy } from '@tabler/icons-react';

// 使い方
// <ButtonCopy content='内容' label='コピー' />
// <ButtonCopy content='内容' /> でアイコンのみ

export function ButtonCopy({
  content,
  label
}: {
  content: string;
  label?: string;
}) {
  const clipboard = useClipboard({ timeout: 500 });
  const icon = clipboard.copied ? <IconCheck size={20} stroke={1.5} /> : <IconCopy size={20} stroke={1.5} />;

  return (
    <Button
      variant='light'
      onClick={() => clipboard.copy(content)}
      color={clipboard.copied ? 'teal' : 'blue'}
      {...(label ? { rightSection: icon } : {})}
    >
      {label ? label : icon}
    </Button>
  );
}
