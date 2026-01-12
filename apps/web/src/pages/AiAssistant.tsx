import { useState, useRef, useEffect } from 'react';
import { aiApi } from '../api/ai';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { MessageCircle, Send, Loader2, Sparkles } from 'lucide-react';
import type { ChatMessage } from '@betterdb/shared';

export function AiAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const suggestedQuestions = [
    "How many clients are connected?",
    "What's the current memory usage?",
    "How many keys are in the database?",
    "Show me server status",
    "Analyze slowlog patterns",
    "Show me the slowest commands",
    "Run a latency diagnosis",
    "Run a memory diagnosis",
    "Show me ACL failures",
    "Show client analytics",
  ];

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: input.trim(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const response = await aiApi.chat({
        message: userMessage.content,
        history: messages,
      });

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.response,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get response from AI helper');
      console.error('Chat error:', err);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestedQuestion = (question: string) => {
    setInput(question);
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col gap-4 w-full" style={{ height: 'calc(100vh - 4rem)' }}>
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold">AI Helper</h1>
          <p className="text-muted-foreground mt-1">
            Ask questions about your Valkey/Redis metrics and configuration
          </p>
        </div>
        <Sparkles className="h-8 w-8 text-primary" />
      </div>

      <div className="flex items-start gap-2 text-sm text-muted-foreground flex-shrink-0">
        <Sparkles className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <p>
          Best for querying metrics, diagnostics, and server stats. General documentation questions may have limited results.
        </p>
      </div>

      <Card className="flex-1 flex flex-col min-h-0">
        <CardHeader className="border-b">
          <CardTitle className="text-lg flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            Chat
          </CardTitle>
          <CardDescription>
            Powered by Qwen 2.5 7B via Ollama
          </CardDescription>
        </CardHeader>

        <CardContent className="flex-1 overflow-y-auto p-6 space-y-4">
          {messages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center space-y-6">
              <div className="space-y-2">
                <h3 className="text-lg font-semibold">Start a conversation</h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  Ask me anything about your database metrics, performance, connections, or configuration.
                </p>
              </div>

              <div className="space-y-2 w-full max-w-md">
                <p className="text-sm font-medium text-muted-foreground">Suggested questions:</p>
                <div className="grid gap-2">
                  {suggestedQuestions.map((question, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSuggestedQuestion(question)}
                      className="text-left px-4 py-2 text-sm border rounded-md hover:bg-muted transition-colors"
                    >
                      {question}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2 ${message.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted'
                  }`}
              >
                <div className="text-sm font-medium mb-1">
                  {message.role === 'user' ? 'You' : 'Helper'}
                </div>
                <div className="text-sm whitespace-pre-wrap break-words">
                  {message.content}
                </div>
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-4 py-2">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Thinking...</span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex justify-center">
              <div className="bg-destructive/10 text-destructive rounded-lg px-4 py-2 text-sm">
                {error}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </CardContent>

        <div className="border-t p-4">
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question... (Shift+Enter for new line)"
              className="flex-1 min-h-[60px] max-h-[120px] px-3 py-2 text-sm border rounded-md bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={loading}
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Type <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">help</kbd> to see example questions · Press Enter to send, Shift+Enter for new line
          </p>
        </div>
      </Card>
    </div>
  );
}
