import { Container, Title } from '@mantine/core';

export default function About() {
  return (
    <Container>
      <Title mt={'sm'} order={2}>
        Aboutページ
      </Title>
      <Title order={6} mb={'sm'} c={'dimmed'}>
        これはAboutページです。
      </Title>
    </Container>
  );
}
