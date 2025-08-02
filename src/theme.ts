import { createTheme } from '@mantine/core';
import { themeToVars } from '@mantine/vanilla-extract';

export const theme = createTheme({
  scale: 1.0,
  defaultRadius: 'xs',
  fontFamily: '"Helvetica Neue", Arial, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif'
});
export const vars = themeToVars(theme);
