/**
 * Orvix Temporary Sample Conversations
 * NOTE: These sample conversations are provided strictly for visual demonstration
 * and UI evaluation. No actual database or persistence is connected.
 */

export const SAMPLE_CHATS = [
  {
    id: 'sample-1',
    title: 'React state management advice',
    timestamp: '2 hours ago',
    isSample: true,
    messages: [
      {
        id: 'm1',
        sender: 'user',
        timestamp: '10:14 AM',
        content: 'When should I choose Zustand over React Context for a web app?'
      },
      {
        id: 'm2',
        sender: 'assistant',
        timestamp: '10:14 AM',
        content: `Here is a practical breakdown to help you choose:

**React Context** is best when:
• State changes infrequently (e.g., theme, current authenticated user, localization).
• You want zero extra dependencies in your bundle.
• The component subtree consuming the context is relatively small.

**Zustand** shines when:
• State updates frequently and you need granular selector subscriptions to prevent unnecessary re-renders.
• You want boilerplate-free store setup without wrapping your app in provider trees.
• You need transient updates or middleware like \`persist\` or \`devtools\`.

\`\`\`javascript
// Minimal Zustand store example
import { create } from 'zustand';

export const useChatStore = create((set) => ({
  activeChat: null,
  setActiveChat: (chat) => set({ activeChat: chat }),
}));
\`\`\`

If your app has rapidly changing inputs or collaborative elements, Zustand provides noticeably better render performance.`
      }
    ]
  },
  {
    id: 'sample-2',
    title: 'Creative startup taglines',
    timestamp: 'Yesterday',
    isSample: true,
    messages: [
      {
        id: 'm3',
        sender: 'user',
        timestamp: '3:20 PM',
        content: 'Suggest 3 concise, punchy taglines for an intelligent productivity tool named Orvix.'
      },
      {
        id: 'm4',
        sender: 'assistant',
        timestamp: '3:20 PM',
        content: `Here are 3 refined, minimal taglines:

1. **"Clarity in every conversation."**  
   Focuses on thought organization and instant understanding.

2. **"Think faster. Build smarter."**  
   Direct, action-oriented, and aimed at builders and knowledge workers.

3. **"Your ambient intelligence layer."**  
   Modern, subtle, and positions Orvix as a seamless companion rather than a distraction.`
      }
    ]
  },
  {
    id: 'sample-3',
    title: 'Explain quantum computing simply',
    timestamp: '3 days ago',
    isSample: true,
    messages: [
      {
        id: 'm5',
        sender: 'user',
        timestamp: '11:05 AM',
        content: 'Can you explain the difference between a classical bit and a qubit using a simple coin analogy?'
      },
      {
        id: 'm6',
        sender: 'assistant',
        timestamp: '11:06 AM',
        content: `Imagine a coin resting on a tabletop:

• **A Classical Bit** is like the coin lying flat: it is definitively either **Heads (1)** or **Tails (0)**. A traditional computer checks the face up, one coin at a time.

• **A Qubit** is like that same coin **spinning rapidly** on its edge. While it spins, it isn't strictly heads or tails—it exists in a blend of both possibilities simultaneously (superposition). Only when you stop the coin (measurement) does it collapse into a definite 0 or 1.

Because many spinning coins can explore vast combinations of possibilities at once, quantum computers can solve specific classes of complex mathematical simulations exponentially faster.`
      }
    ]
  }
];
