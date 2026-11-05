/**
 * @format
 */

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import App from '../App';

test('renders correctly', async () => {
  let root: any;
  await act(async () => {
    root = ReactTestRenderer.create(<App />);
    await new Promise((resolve) => setTimeout(() => resolve(undefined), 50));
  });
  expect(root).toBeDefined();
});
