import json
import time
from pathlib import Path

import boto3


def main():
    ssm = boto3.client("ssm")
    image_id = ssm.get_parameter(
        Name="/aws/service/ami-amazon-linux-latest/al2023-ami-minimal-kernel-default-x86_64"
    )["Parameter"]["Value"]

    ec2 = boto3.client("ec2")

    az = get_az(ec2)

    tags = [
        {
            "Key": "Name",
            "Value": "arch-kernel-cloud-build",
        }
    ]

    vol = get_create_volume(ec2, az, tags)

    instance = ec2.run_instances(
        ImageId=image_id,
        MinCount=1,
        MaxCount=1,
        InstanceType="t3.small",
        Placement={"AvailabilityZone": az},
        KeyName="EC2PlaygroundToolkit-SkK33YSnxAkXaOC4fUy8fw",
        SecurityGroupIds=["sg-03e9b06c1071c484b"],
        TagSpecifications=[
            {"ResourceType": "instance", "Tags": tags},
        ],
        UserData=Path("user-data.sh").read_text(),
    )["Instances"][0]
    print(f'Instance {instance["InstanceId"]} created')

    while instance_pending(instance) or vol_pending(vol):
        if instance_pending(instance):
            instance = ec2.describe_instances(InstanceIds=[instance["InstanceId"]])[
                "Reservations"
            ][0]["Instances"][0]
        else:
            print(
                f'Instance {instance["InstanceId"]} is running at {instance.get("PublicIpAddress")}'
            )
        if vol_pending(vol):
            vol = get_volume(ec2, vol["VolumeId"])
        else:
            print("Volume is available")

        if instance_invalid(instance):
            raise ValueError(
                f'Instance {({k: v for k, v in instance.items() if k in ("InstanceId", "State")})}'
            )
        if vol_invalid(vol):
            raise ValueError(
                f'Volume {({k: v for k, v in vol.items() if k in ("VolumeId", "State")})}'
            )

        time.sleep(15)


def get_az(ec2) -> str:
    resp = ec2.describe_availability_zones()
    for zone in resp.get("AvailabilityZones"):
        if zone["OptInStatus"] != "not-opted-in" and zone["State"] == "available":
            print(f"using AZ {zone}")
            return zone["ZoneName"]

    raise ValueError("No available AZ found")


def get_create_volume(ec2, az, tags) -> dict:
    cfg = {}
    if (cfg_file := Path("config.json")).exists():
        cfg = json.loads(cfg_file.read_text())
        if vol_id := cfg.get("VolumeId"):
            return get_volume(ec2, vol_id)

    vol = ec2.create_volume(
        AvailabilityZone=az,
        Size=20,
        VolumeType="gp3",
        TagSpecifications=[
            {"ResourceType": "volume", "Tags": tags},
        ],
    )
    cfg_file.write_text(json.dumps(cfg | {"VolumeId": vol["VolumeId"]}))
    print(f'Volume {vol["VolumeId"]} created')

    return vol


def get_volume(ec2, vol_id: str) -> dict:
    return ec2.describe_volumes(VolumeIds=[vol_id])["Volumes"][0]


def instance_pending(instance):
    return instance["State"]["Name"] == "pending"


def vol_pending(vol):
    return vol["State"] == "creating"


def instance_invalid(instance):
    return instance["State"]["Name"] in ("shutting-down", "terminated", "stopping", "stopped")


def vol_invalid(vol):
    return vol["State"] in ("in-use", "deleting", "deleted", "error")


if __name__ == "__main__":
    main()
