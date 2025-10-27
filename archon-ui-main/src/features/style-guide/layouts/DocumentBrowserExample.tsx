import { Code, FileText, Globe, Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Dialog, DialogContent } from "@/features/ui/primitives/dialog";
import { Input } from "@/features/ui/primitives/input";
import { cn } from "@/features/ui/primitives/styles";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/features/ui/primitives/tabs";

const MOCK_DOCUMENTS = [
  {
    id: "1",
    title: "[Radix Homepage](https://www.radix-ui.com/)[Made by WorkOS](https://workos.com)",
    preview: "[Radix Homepage](https://www.radix-ui.com/)[Made by WorkOS]...",
    content:
      "[Radix Homepage](https://www.radix-ui.com/)[Made by WorkOS](https://workos.com)\n\n[ThemesThemes](https://www.radix-ui.com/)[PrimitivesPrimitives](https://www.radix-ui.com/primitives)[IconsIcons](https://www.radix-ui.com/icons)[ColorsColors](https://www.radix-ui.com/colors)\n\n[Documentation](https://www.radix-ui.com/themes/docs/overview/getting-started)[Playground](https://www.radix-ui.com/themes/playground)[Blog](https://www.radix-ui.com/blog)[](https://github.com/radix-ui/themes)",
    sourceType: "Web" as const,
    category: "Technical" as const,
    url: "https://www.radix-ui.com/primitives/docs/guides/styling",
  },
  {
    id: "2",
    title: "Deleted report #34",
    preview: "7-4d586f394674?&w=64&h=64&dpr=2&q=70&crop=faces...",
    content: "Detailed report content...",
    sourceType: "Document" as const,
    category: "Technical" as const,
  },
  {
    id: "3",
    title: "Latest updates",
    preview: "[Radix Homepage](https://www.radix-ui.com/)[Made by WorkOS]...",
    content: "Latest updates and changes...",
    sourceType: "Web" as const,
    category: "Technical" as const,
    url: "https://www.radix-ui.com",
  },
];

const MOCK_CODE = [
  {
    id: "1",
    language: "typescript",
    summary: "React component example",
    code: `const Example = () => {\n  return <div>Hello</div>;\n};`,
  },
  {
    id: "2",
    language: "python",
    summary: "FastAPI endpoint",
    code: `@app.get("/api/test")\nasync def test():\n    return {"status": "ok"}`,
  },
];

export const DocumentBrowserExample = () => {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        <strong>Use this pattern for:</strong> Document browser with header showing source type pills (Web
        Page/Document), knowledge type badges (Technical/Business), and StatPills for counts. Uses Radix primitives for
        all components.
      </p>

      <Button onClick={() => setOpen(true)}>Open Document Browser Example</Button>

      <DocumentBrowserModal open={open} onOpenChange={setOpen} />
    </div>
  );
};

const DocumentBrowserModal = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const [activeTab, setActiveTab] = useState<"documents" | "code">("documents");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDoc, setSelectedDoc] = useState(MOCK_DOCUMENTS[0]);
  const [selectedCode, setSelectedCode] = useState(MOCK_CODE[0]);

  const filteredDocuments = MOCK_DOCUMENTS.filter((doc) => doc.title.toLowerCase().includes(searchQuery.toLowerCase()));

  const filteredCode = MOCK_CODE.filter((example) => example.summary.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl h-[80vh] flex flex-col p-0">
        {/* Header - EXACT layout from InspectorHeader.tsx line 31-93 */}
        <div className="px-6 py-4 border-b border-white/10">
          <div className="flex items-start justify-between mb-4">
            <div className="flex-1">
              <h2 className="text-xl font-semibold text-white mb-2">Radix UI</h2>
              <div className="flex flex-wrap items-center gap-3">
                {/* Source Type Badge - exact classes from InspectorHeader line 37-56 */}
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  <Globe className="w-3.5 h-3.5" />
                  Web
                </span>

                {/* Knowledge Type Badge - exact classes from InspectorHeader line 59-78 */}
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                  <span>Technical</span>
                </span>

                {/* URL - exact classes from InspectorHeader line 81-90 */}
                <a
                  href="https://www.radix-ui.com/primitives/docs/guides/styling"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-cyan-400 hover:text-cyan-300 truncate max-w-xs"
                >
                  https://www.radix-ui.com/primitives/docs/guides/styling
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs and Content */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as typeof activeTab)}
          className="flex-1 flex flex-col px-6"
        >
          <div className="flex justify-start mb-4 mt-6">
            <TabsList>
              <TabsTrigger value="documents" color="cyan">
                <FileText className="w-4 h-4" />
                Documents
              </TabsTrigger>
              <TabsTrigger value="code" color="cyan">
                <Code className="w-4 h-4" />
                Code Examples
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Documents Tab - Left Sidebar + Right Content */}
          <TabsContent value="documents" className="flex-1 flex">
            {/* Left Sidebar */}
            <div className="w-80 flex flex-col pr-4 border-r border-gray-700">
              <div className="relative mb-4">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <Input
                  placeholder="Search documents..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>

              <div className="flex-1 overflow-y-auto space-y-2">
                {filteredDocuments.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => setSelectedDoc(doc)}
                    className={cn(
                      "w-full text-left p-3 rounded-lg transition-colors",
                      selectedDoc.id === doc.id ? "bg-cyan-500/10 border border-cyan-500/30" : "hover:bg-white/5",
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <FileText className="w-4 h-4 text-cyan-400" />
                      <span className="font-medium text-sm text-white line-clamp-1">{doc.title}</span>
                    </div>
                    <p className="text-xs text-gray-400 line-clamp-2">{doc.preview}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Right Content */}
            <div className="flex-1 overflow-y-auto pl-6">
              {/* Header with badges and URL */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <span className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-cyan-100 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-400">
                    <Globe className="w-3.5 h-3.5" />
                    {selectedDoc.sourceType}
                  </span>
                  <span className="px-2 py-1 text-xs rounded-md font-medium bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
                    {selectedDoc.category}
                  </span>
                </div>
                {selectedDoc.url && (
                  <a
                    href={selectedDoc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-cyan-400 hover:text-cyan-300 inline-block mb-4"
                  >
                    {selectedDoc.url}
                  </a>
                )}
              </div>

              <div className="prose prose-invert max-w-none">
                <p className="text-gray-300 whitespace-pre-wrap">{selectedDoc.content}</p>
              </div>
            </div>
          </TabsContent>

          {/* Code Tab - Left Sidebar + Right Content */}
          <TabsContent value="code" className="flex-1 flex">
            {/* Left Sidebar */}
            <div className="w-80 flex flex-col pr-4 border-r border-gray-700">
              <div className="flex-1 overflow-y-auto space-y-2">
                {filteredCode.map((code) => (
                  <button
                    key={code.id}
                    type="button"
                    onClick={() => setSelectedCode(code)}
                    className={cn(
                      "w-full text-left p-3 rounded-lg transition-colors",
                      selectedCode.id === code.id ? "bg-cyan-500/10 border border-cyan-500/30" : "hover:bg-white/5",
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Code className="w-4 h-4 text-cyan-400" />
                      <span className="px-2 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded">{code.language}</span>
                    </div>
                    <p className="text-xs text-gray-400 line-clamp-2">{code.summary}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Right Content */}
            <div className="flex-1 overflow-y-auto pl-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white">{selectedCode.summary}</h3>
                <span className="px-2 py-1 text-xs bg-cyan-500/20 text-cyan-400 rounded">{selectedCode.language}</span>
              </div>
              <pre className="bg-black/30 rounded-lg p-4 overflow-x-auto scrollbar-hide">
                <code className="text-gray-300 text-sm">{selectedCode.code}</code>
              </pre>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
