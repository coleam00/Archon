import { useId } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Card } from "@/features/ui/primitives/card";
import { Checkbox } from "@/features/ui/primitives/checkbox";
import { Input } from "@/features/ui/primitives/input";
import { Label } from "@/features/ui/primitives/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { Switch } from "@/features/ui/primitives/switch";

export const StaticForms = () => {
  const exampleInputId = useId();
  const exampleDisabledId = useId();
  const exampleTextareaId = useId();
  const check1Id = useId();
  const check2Id = useId();
  const check3Id = useId();
  const switch1Id = useId();
  const switch2Id = useId();
  const switch3Id = useId();
  const selectCyanId = useId();
  const selectPurpleId = useId();
  const formInputId = useId();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Form Elements</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Form inputs and controls used in the application</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Text Input */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Text Input</h4>
          <div className="space-y-3">
            <div>
              <Label htmlFor={exampleInputId}>Label</Label>
              <Input id={exampleInputId} placeholder="Enter text..." className="mt-1" />
            </div>
            <div>
              <Label htmlFor={exampleDisabledId}>Disabled</Label>
              <Input id={exampleDisabledId} placeholder="Disabled..." disabled className="mt-1" />
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">{"<Input />"}</p>
        </Card>

        {/* Textarea */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Textarea</h4>
          <div>
            <Label htmlFor={exampleTextareaId}>Description</Label>
            <textarea
              id={exampleTextareaId}
              placeholder="Enter description..."
              rows={4}
              className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white/50 dark:bg-black/30 px-3 py-2 text-sm backdrop-blur-sm focus:border-cyan-500 focus:outline-none"
            />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">{"<textarea />"}</p>
        </Card>

        {/* Checkbox */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Checkbox</h4>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Checkbox id={check1Id} defaultChecked color="cyan" />
              <Label htmlFor={check1Id}>Checked</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id={check2Id} color="purple" />
              <Label htmlFor={check2Id}>Unchecked</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id={check3Id} disabled defaultChecked />
              <Label htmlFor={check3Id}>Disabled</Label>
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">{"<Checkbox />"}</p>
        </Card>

        {/* Switch Toggle */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Switch Toggle</h4>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor={switch1Id}>Enable Feature</Label>
              <Switch id={switch1Id} defaultChecked />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor={switch2Id}>Dark Mode</Label>
              <Switch id={switch2Id} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor={switch3Id}>Disabled</Label>
              <Switch id={switch3Id} disabled />
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">{"<Switch />"}</p>
        </Card>

        {/* Select Dropdown */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Select Dropdown</h4>
          <div className="space-y-3">
            <div>
              <Label htmlFor={selectCyanId}>Cyan Variant</Label>
              <Select defaultValue="option2">
                <SelectTrigger id={selectCyanId} color="cyan" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="option1">Option 1</SelectItem>
                  <SelectItem value="option2">Option 2</SelectItem>
                  <SelectItem value="option3">Option 3</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor={selectPurpleId}>Purple Variant</Label>
              <Select defaultValue="option1">
                <SelectTrigger id={selectPurpleId} color="purple" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent color="purple">
                  <SelectItem value="option1">Option 1</SelectItem>
                  <SelectItem value="option2">Option 2</SelectItem>
                  <SelectItem value="option3">Option 3</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">{"<Select /> with color variants"}</p>
        </Card>

        {/* Submit Button */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Form Submission</h4>
          <div className="space-y-3">
            <div>
              <Label htmlFor={formInputId}>Email</Label>
              <Input id={formInputId} type="email" placeholder="email@example.com" className="mt-1" />
            </div>
            <Button variant="default" className="w-full">
              Submit
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">Complete form example</p>
        </Card>
      </div>
    </div>
  );
};
