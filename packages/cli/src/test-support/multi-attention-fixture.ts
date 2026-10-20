export const multiAttentionWorkflows = {
  questions: `name: questions
description: open independent questions together
worktree:
  enabled: false
nodes:
  - id: list
    bash: >-
      printf '%s' '[{"key":"first","message":"First? Recommended accept"},{"key":"second","message":"Second? Recommended defer"}]'
  - id: answers
    depends_on: [list]
    workflow: question
    fan_out:
      items: "$list.output"
      as: question
      max_parallel: all
`,
  question: `name: question
description: apply one independent answer
inputs:
  question: { required: true }
returns: apply
nodes:
  - id: question
    bash: printf '%s' "$INPUTS_QUESTION"
    output_format:
      type: object
      properties:
        key: { type: string }
        message: { type: string }
      required: [key, message]
  - id: ask
    depends_on: [question]
    wait:
      attention: "$question.output.message"
      form: select
      options: [{ id: accept }, { id: defer }]
  - id: apply
    depends_on: [ask]
    runtime: bun
    with:
      question: $question.output
      answer: $ask.output
    script: |
      const question = JSON.parse(process.env.INPUTS_QUESTION);
      const answer = JSON.parse(process.env.INPUTS_ANSWER);
      console.log(JSON.stringify({ key: question.key, decision: answer.decision }));
    output_format:
      type: object
      properties:
        key: { type: string }
        decision: { type: string }
      required: [key, decision]
`,
};
