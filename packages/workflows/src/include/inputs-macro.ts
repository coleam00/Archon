import type { DagNode, IncludeDirective, WorkflowDefinition } from '../schemas';
import { INPUT_NAME_SOURCE, inputEnvKey } from '../schemas';
import { canonicalValueText, parseWholeInputsRef, type JsonValue } from '../output-ref';
import { resolveDeclaredInputs } from '../workflow-inputs';
import { parseWhenExpression } from '../when-atom';
import { mapNodeTemplateSlots, mapNodeTemplateValueSlots } from '../template-walker';
import { readComposedBindings, readComposedMeta } from '../compiled-command';
import { IncludeExpansionError } from './expansion-error';

/**
 * Load-time include parameter references. Built from the same identifier source the
 * `with:` key validator uses (INPUT_NAME_SOURCE, homed in output-ref.ts and re-exported
 * by schemas/node-bindings.ts) so a key that validates can never fail to match here — see the
 * re-export's comment for why the drift between the two is silent in one direction.
 */
const INPUTS_REF = new RegExp(String.raw`\$INPUTS\.(${INPUT_NAME_SOURCE})`, 'g');

/**
 * Apply an include node's input mapping to every inline text surface in the cloned node.
 * Unlike output-ref rewriting, substitutions also apply inside Markdown code spans because
 * `$INPUTS` has no documentation-only meaning. An inserted value may itself be a
 * `$node.output` reference; it deliberately remains unresolved for the executor's existing
 * runtime substitution pass.
 *
 * This walks the same field set as rewriteNodeOutputRefs. It was deliberately a SUPERSET
 * until #1764 — it added systemPrompt and agents.*, which took include inputs but had no
 * runtime substitution pass — and that asymmetry is exactly what made a workflow using
 * `$INPUTS.<name>` in a `systemPrompt:` resolve when composed and stay literal standalone
 * (#2476). Those fields are ordinary runtime surfaces now, so the two sets agree.
 *
 * The asymmetry in FAILURE MODE remains, and is why a missed surface matters more here:
 *
 *   - a surface rewriteNodeOutputRefs misses is only a NAMESPACING miss; the executor's
 *     substituteNodeOutputRefs pass still resolves the ref at run time.
 *   - a surface this function misses is permanent. The literal `$INPUTS.<name>` reaches
 *     the model as text, and because the field was never visited the name never reaches
 *     `missing` either — so a caller who forgot to supply it gets no load error.
 *
 * Every model-facing string field must be walked for include inputs. A future field that
 * takes include inputs but is NOT a runtime node-ref surface would reopen the #2476 gap;
 * it belongs in one of these two functions, not silently in this one alone.
 */
export function applyInputsMacro(
  node: DagNode,
  args: Record<string, JsonValue>,
  missing: Set<string>,
  includeNode: IncludeDirective
): void {
  const substitute = (
    text: string,
    shielded?: ReadonlySet<string>,
    // Canonical text (#2637): a typed input splices as its one deterministic
    // representation (strings raw, everything else canonical JSON text).
    render: (name: string) => string = name => canonicalValueText(args[name])
  ): string =>
    text.replace(INPUTS_REF, (match, name: string) => {
      // A name the node's own `with:` binds is neither the caller's to supply nor the
      // caller's to override — it resolves at run time from the nearest source in the
      // documented precedence order, so it is left standing for the executor (#2964).
      if (shielded?.has(name) === true) return match;
      // `Object.hasOwn` rather than a plain `args[name]` lookup: a bare index read reaches
      // Object.prototype, so an unsupplied `$INPUTS.toString` / `$INPUTS.constructor`
      // would resolve to an inherited member and splice a native function body into the
      // prompt instead of being reported as a missing input. Anything not supplied as an
      // OWN key is missing, and missing always fails the load — never a silent passthrough.
      if (!Object.hasOwn(args, name)) {
        missing.add(name);
        return match;
      }
      return render(name);
    });

  // Value-position substitution (#2637): in a `with:` map value, a string that is
  // EXACTLY `$INPUTS.<name>` forwards the LOGICAL input value (a boolean stays a
  // boolean through nested composition); any other string splices text as usual, and
  // non-strings carry no macro at all.
  const substituteValue = (value: JsonValue): JsonValue => {
    if (typeof value !== 'string') return value;
    const name = parseWholeInputsRef(value);
    if (name !== undefined) {
      if (Object.hasOwn(args, name)) return args[name];
      missing.add(name);
      return value;
    }
    return substitute(value);
  };

  const substituteWhen = (when: string): string => {
    const expanded = substitute(when);
    const wasParseable = parseWhenExpression(when) !== null;
    const isParseable = parseWhenExpression(expanded) !== null;
    if (expanded !== when && wasParseable && !isParseable) {
      throw new IncludeExpansionError(
        `Node '${includeNode.id}': input substitution made included node '${node.id}' field 'when' unparseable: "${when}" became "${expanded}". Put '$INPUTS.<name>' on the right-hand side of a comparison whose left-hand side is a node-output reference.`
      );
    }
    return expanded;
  };

  for (const boundary of readComposedMeta(node)?.boundaries ?? []) {
    if (boundary.when !== undefined) boundary.when = substituteWhen(boundary.when);
  }

  const textMapped = mapNodeTemplateSlots(node, slot => {
    if (slot.surface === 'binding_from' || slot.name === 'binding.if_skipped') return slot.value;
    if (
      slot.name.endsWith('with.*') ||
      slot.name === 'binding.value' ||
      slot.name === 'composed.inputs.*'
    )
      return slot.value;
    if (slot.surface === 'condition') return substituteWhen(slot.value);
    // Executable source never receives an input value (#2115): the shell delivers each
    // input as INPUTS_<UPPER_SNAKE>, so a bash body keeps the author's macro as a quoted
    // reference to that variable. Inline script languages share no safe quoting form,
    // so there the macro is refused and the author reads the env var directly.
    if (slot.surface === 'shell')
      return substitute(slot.value, undefined, name => `"\${${inputEnvKey(name)}}"`);
    if (slot.surface === 'script') {
      const name = slot.value.matchAll(INPUTS_REF).next().value?.[1];
      if (name !== undefined)
        throw new IncludeExpansionError(
          `Node '${includeNode.id}': included node '${slot.owner.id}' script uses '$INPUTS.${name}', which would splice the input value into script source. Read it from the environment as ${inputEnvKey(name)} instead.`
        );
      return slot.value;
    }
    // Names a command node supplies itself. Only its compiled body reads them: the
    // executor merges the node's resolved bindings OVER the run inputs into the `$INPUTS`
    // bag it builds for the prompt, and nothing else (dag-executor.ts). So the shield is
    // scoped to that one surface — a `when:` or `systemPrompt:` naming the same input
    // still reads the run's bag, and a caller who never supplied it still gets the load
    // error. The slot's owner, not `node`, holds the bindings: the walk also visits
    // loop_group body nodes.
    return substitute(
      slot.value,
      slot.name === 'agent.prompt'
        ? new Set(Object.keys(readComposedBindings(slot.owner) ?? {}))
        : undefined
    );
  });
  const valueMapped = mapNodeTemplateValueSlots(textMapped, slot => {
    const value = substituteValue(slot.value);
    if (
      slot.position === 'binding' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const bindingName = slot.path.slice(slot.path.lastIndexOf('with.') + 'with.'.length);
      throw new IncludeExpansionError(
        `Node '${includeNode.id}': input substitution supplied an OBJECT to binding '${bindingName}' of included node '${node.id}' (value '${canonicalValueText(slot.value)}'). Command/script binding values must be strings, numbers, booleans, null, or arrays; a binding directive must be authored in the block itself, never forwarded through an input.`
      );
    }
    return value;
  });
  Object.assign(node, valueMapped);
}

/**
 * Resolve a caller's `with:` map against a block's declared `inputs:` (#2470).
 * Only active when the block declares `inputs:` — an undeclared block keeps Phase-1
 * behaviour byte-for-byte (the caller's `with:` passes through verbatim). When declared:
 * applies each input's `default` for an omitted name, errors on an unsupplied `required`
 * input, and errors on a caller `with:` key the block doesn't declare.
 */
export function resolveIncludeInputs(
  includeNode: IncludeDirective,
  child: Pick<WorkflowDefinition, 'name' | 'inputs'>
): Record<string, JsonValue> {
  try {
    return resolveDeclaredInputs(
      includeNode.with ?? {},
      child.inputs,
      `Node '${includeNode.id}'`,
      `included block '${child.name}'`
    );
  } catch (err) {
    // Re-typed so the per-workflow expansion loop treats a contract violation as the
    // same resilient "drop one workflow, keep the rest" failure as every other
    // expansion error, rather than escaping as an unhandled throw.
    throw new IncludeExpansionError((err as Error).message);
  }
}
