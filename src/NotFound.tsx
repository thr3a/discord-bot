import { Button, Center, Container, Group, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <Center style={{ minHeight: '60vh' }}>
      <Container>
        <Stack align='center' gap='md'>
          <Title order={2} c='red.6'>
            404 Not Found
          </Title>
          <Text c='dimmed' ta='center'>
            お探しのページは見つかりませんでした。
          </Text>
          <Group>
            <Button component={Link} to='/'>
              ホームに戻る
            </Button>
          </Group>
        </Stack>
      </Container>
    </Center>
  );
}
