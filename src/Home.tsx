import { Container, Title } from '@mantine/core';

export default function Home() {
  return (
    <Container maw={400}>
      <Title mt={'sm'} order={2}>
        Mantine Vite template
      </Title>
      <Title order={6} mb={'sm'} c={'dimmed'}>
        Mantine Vite template
      </Title>
    </Container>
  );
}
