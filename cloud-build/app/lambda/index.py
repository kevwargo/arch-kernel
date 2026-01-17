import json


def run_instance(event, _):
    print(json.dumps(event, default=str))
    return {}


def on_error(event, _):
    print(json.dumps({"errorDetails": event}, default=str))
    return {}
