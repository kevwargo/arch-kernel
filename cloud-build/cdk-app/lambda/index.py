import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from string import Template

import boto3

TAG_RESOURCE_ID = "sfn-imgbuilder-resource-id"
EC2_LOGFILE = "/var/log/sfn-imgbuilder.log"

ec2 = boto3.client("ec2")


class ShellTemplate(Template):
    pattern = """@(?:
    (?P<escaped>@)                  |
    (?P<named>[A-Z][A-Z0-9_]*)      |
    {{(?P<braced>[A-Z][A-Z0-9_]*)}} |
    (?P<invalid>)
    )@"""
    flags = re.ASCII


def run_instance(event, _):
    tmpl = ShellTemplate((Path(__file__).parent / "user-data-tmpl.sh").read_text())
    user_data = tmpl.substitute(
        TASK_TOKEN=event["taskToken"],
        LOGFILE=EC2_LOGFILE,
        SCRIPT="\n    ".join(event["prepareScript"]),
    )

    params = dict(
        ImageId=event["sourceImageId"],
        MinCount=1,
        MaxCount=1,
        InstanceType=event["instanceType"],
        SecurityGroupIds=[event["securityGroupId"]],
        IamInstanceProfile={"Arn": event["instanceProfileArn"]},
        UserData=user_data,
        MetadataOptions={"HttpTokens": "optional"},
        BlockDeviceMappings=[
            {
                "DeviceName": "/dev/xvda",
                "Ebs": {"VolumeSize": event["rootVolSize"]},
            }
        ],
        TagSpecifications=[
            {
                "ResourceType": "instance",
                "Tags": [
                    {
                        "Key": "Name",
                        "Value": f'image-build-{event["imageName"]}',
                    },
                    {
                        "Key": TAG_RESOURCE_ID,
                        "Value": event["resourceId"],
                    },
                ],
            },
        ],
    )

    if key_name := event.get("keyName"):
        params["KeyName"] = key_name

    try:
        instance = ec2.run_instances(**params)["Instances"][0]
        log("on_create: created EC2 instance", instance=instance, params=params)
    except Exception as e:
        log(f"on_create: failed to run instance: {type(e).__name__}({e})", params=params)
        raise


def stop_instance(instance: dict, _):
    instance_id = instance["id"]
    state = ec2.describe_instances(InstanceIds=[instance_id])["Reservations"][0]["Instances"][
        0
    ]["State"]["Name"]
    if state == "running":
        ec2.stop_instances(InstanceIds=[instance_id])
        return False
    if state == "stopping":
        return False
    if state == "stopped":
        return True

    raise ValueError(f"Unexpected state {state} for instance {instance_id}")


def create_image(event: dict, _):
    if image_id := event.get("image", {}).get("id"):
        state = ec2.describe_images(ImageIds=[image_id])["Images"][0]["State"]
        if state == "available":
            ec2.terminate_instances(InstanceIds=[event["instance"]["id"]])
            return {"id": image_id, "available": True}
        if state in ("pending", "transient"):
            return {"id": image_id, "available": False}

        raise ValueError(f"Unexpected state {state} for image {image_id}")

    image_id = ec2.create_image(
        InstanceId=event["instance"]["id"],
        Name=os.getenv("IMAGE_NAME"),
        TagSpecifications=[
            {
                "ResourceType": "image",
                "Tags": [
                    {
                        "Key": TAG_RESOURCE_ID,
                        "Value": event["resourceId"],
                    },
                ],
            },
            {
                "ResourceType": "snapshot",
                "Tags": [
                    {
                        "Key": TAG_RESOURCE_ID,
                        "Value": event["resourceId"],
                    },
                ],
            },
        ],
    )["ImageId"]

    return {"id": image_id, "available": False}


def on_error(event, _):
    print(json.dumps({"errorDetails": event}, default=str))
    return {}


def log(msg: str, **fields):
    print(json.dumps({"msg": msg, "time": datetime.now(UTC), **fields}, default=str))
