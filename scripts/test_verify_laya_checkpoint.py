import unittest

from verify_laya_checkpoint import (
    CHECKPOINT_VERIFICATION,
    CheckpointVerificationError,
    EXPECTED_TENSOR_COUNT,
    verify_and_load_state_dict,
)


class FakeTensor:
    def __init__(self, shape=(1,), dtype="float16"):
        self.shape = shape
        self.dtype = dtype

    def to(self, *, dtype):
        return FakeTensor(shape=self.shape, dtype=dtype)


class FakeModel:
    def __init__(self, state):
        self._state = state
        self.load_strict = None
        self.loaded_state = None
        self.float_called = False
        self.eval_called = False

    def state_dict(self):
        return self._state

    def load_state_dict(self, state, *, strict):
        self.load_strict = strict
        self.loaded_state = state
        return type(
            "IncompatibleKeys", (), {"missing_keys": [], "unexpected_keys": []}
        )()

    def float(self):
        self.float_called = True
        return self

    def eval(self):
        self.eval_called = True
        return self


def make_states(
    model_count=EXPECTED_TENSOR_COUNT, checkpoint_count=EXPECTED_TENSOR_COUNT
):
    model = {
        f"tensor_{index}": FakeTensor(dtype="float32") for index in range(model_count)
    }
    checkpoint = {
        f"tensor_{index}": FakeTensor(dtype="float16")
        for index in range(checkpoint_count)
    }
    return model, checkpoint


class VerifyLayaCheckpointTests(unittest.TestCase):
    def verify(self, model_state, checkpoint_state):
        model = FakeModel(model_state)
        marker = verify_and_load_state_dict(
            model,
            checkpoint_state,
            float16_dtype="float16",
            float32_dtype="float32",
        )
        return model, marker

    def test_exact_checkpoint_is_converted_f16_to_f32_and_strictly_loaded(self):
        model_state, checkpoint_state = make_states()
        model, marker = self.verify(model_state, checkpoint_state)

        self.assertTrue(model.load_strict)
        self.assertEqual(len(model.loaded_state), EXPECTED_TENSOR_COUNT)
        self.assertTrue(
            all(tensor.dtype == "float32" for tensor in model.loaded_state.values())
        )
        self.assertTrue(model.float_called)
        self.assertTrue(model.eval_called)
        self.assertEqual(marker, CHECKPOINT_VERIFICATION)

    def test_rejects_missing_checkpoint_key(self):
        model_state, checkpoint_state = make_states(
            model_count=EXPECTED_TENSOR_COUNT + 1
        )
        with self.assertRaisesRegex(CheckpointVerificationError, "missing=1"):
            self.verify(model_state, checkpoint_state)

    def test_rejects_unexpected_checkpoint_key(self):
        model_state, checkpoint_state = make_states()
        del checkpoint_state["tensor_205"]
        checkpoint_state["unexpected"] = FakeTensor(dtype="float16")
        with self.assertRaisesRegex(CheckpointVerificationError, "unexpected=1"):
            self.verify(model_state, checkpoint_state)

    def test_rejects_shape_mismatch(self):
        model_state, checkpoint_state = make_states()
        checkpoint_state["tensor_0"] = FakeTensor(shape=(2,), dtype="float16")
        with self.assertRaisesRegex(CheckpointVerificationError, "shape mismatch"):
            self.verify(model_state, checkpoint_state)

    def test_rejects_checkpoint_dtype_mismatch(self):
        model_state, checkpoint_state = make_states()
        checkpoint_state["tensor_0"] = FakeTensor(dtype="float32")
        with self.assertRaisesRegex(CheckpointVerificationError, "expected float16"):
            self.verify(model_state, checkpoint_state)

    def test_rejects_non_fp32_export_model_state(self):
        model_state, checkpoint_state = make_states()
        model_state["tensor_0"] = FakeTensor(dtype="float16")
        with self.assertRaisesRegex(CheckpointVerificationError, "expected float32"):
            self.verify(model_state, checkpoint_state)


if __name__ == "__main__":
    unittest.main()
