// Server component. It only renders the client chat component.

import ChatClient from './ChatClient';

export default function Home() {
  return (
    <main>
      <ChatClient />
    </main>
  );
}
